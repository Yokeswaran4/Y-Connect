// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import org.java_websocket.WebSocket
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.handshake.ServerHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.URI
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

data class HubSettings(
    val name: String,
    val clipboardSync: Boolean,
    val notifySync: Boolean,
    val acceptFiles: Boolean = true,
    val theme: String = "system", // system | light | dark
    val systemColors: Boolean = false, // Material You wallpaper colours (Android 12+); off = Y Connect desktop look (default)
    val batterySync: Boolean = true,  // share this phone's battery and show the other devices'
    val autoClipboard: Boolean = false, // send the phone's clipboard automatically (needs "Display over other apps")
    val shareStorage: Boolean = false,  // a paired computer may mount this phone's storage (read only until storageWrite is on)
    val storageWrite: Boolean = false,  // ... and may also change files
    val allowControl: Boolean = false,  // a device that views our shared screen may touch / type here (needs the accessibility service)
)
data class Peer(val id: String, val name: String, val platform: String, val address: String, val battery: Int = -1, val charging: Boolean = false)
/** A device that has Y Connect open on this network but is not connected to us (yet). */
data class Nearby(val id: String, val name: String, val platform: String, val address: String)
/** Another device asked to pair: the user sees Accept / Decline, plus a check number that must match on both screens. */
data class PairRequest(val id: String, val name: String, val address: String, val sas: String)
/** We asked another device to pair. state: waiting | declined | failed. */
data class PairOut(val id: String, val name: String, val sas: String, val state: String)
/** Per socket: who is behind it, which key protects it and (while pairing) the key exchange. */
internal class PairSess(val role: String, val id: String, val name: String, val priv: java.security.PrivateKey?, val pub: String, var secret: ByteArray? = null) {
    var accepted = false; var sent = false; var done = false
}
internal class ConnState(var mode: String, var peerId: String? = null, var key: ByteArray? = null) {
    var helloSent = false; var pair: PairSess? = null
}
data class LogEntry(val time: Long, val kind: String, val title: String, val text: String, val count: Int = 1)

/** Everything network-related lives here: WebSocket server + client, UDP discovery, message handling. */
object Hub {
    const val WS_PORT = 48998
    const val UDP_PORT = 48999

    val settings = MutableStateFlow(HubSettings("", true, true))
    val peers = MutableStateFlow<List<Peer>>(emptyList())
    val log = MutableStateFlow<List<LogEntry>>(emptyList())
    val localIps = MutableStateFlow<List<String>>(emptyList())
    val nearby = MutableStateFlow<List<Nearby>>(emptyList())
    val pairRequest = MutableStateFlow<PairRequest?>(null)
    val pairOut = MutableStateFlow<PairOut?>(null)

    private class NearbyEntry(val id: String, val name: String, val platform: String, val address: String, val port: Int, val seen: Long)
    private val nearbyMap = ConcurrentHashMap<String, NearbyEntry>()
    /** One random pairing code per paired device (id -> code) and the AES key derived from it. */
    private val pairCodes = ConcurrentHashMap<String, String>()
    private val pairNames = ConcurrentHashMap<String, String>()
    private val pairKeys = ConcurrentHashMap<String, ByteArray>()
    private val waitingSince = ConcurrentHashMap<String, Long>()
    internal val conns = ConcurrentHashMap<WebSocket, ConnState>()
    private var pairReqConn: WebSocket? = null
    private var pairOutConn: WebSocket? = null
    internal fun keyFor(conn: WebSocket): ByteArray? = conns[conn]?.key
    private fun st(conn: WebSocket) = conns.getOrPut(conn) { ConnState("in") }

    private fun savePairs() {
        val o = JSONObject()
        for ((id, code) in pairCodes) o.put(id, JSONObject().put("code", code).put("name", pairNames[id] ?: "Device"))
        prefs.edit().putString("pairs", o.toString()).apply()
    }
    private fun storePair(id: String, name: String, code: String) {
        val k = Crypto.deriveKey(code)
        pairCodes[id] = code; pairNames[id] = name.take(40); pairKeys[id] = k
        savePairs()
    }
    /** Unpairing only forgets this one device's code. Nothing else changes, and pairing again makes a new random code. */
    private fun forgetPair(id: String) {
        pairCodes.remove(id); pairNames.remove(id); pairKeys.remove(id); waitingSince.remove(id)
        savePairs()
    }
    private const val NEARBY_TTL = 10_000L

    internal val connecting: MutableSet<String> = ConcurrentHashMap.newKeySet()

    internal lateinit var appCtx: Context
    private lateinit var prefs: SharedPreferences
    internal lateinit var myId: String
    @Volatile private var started = false
    private var server: HubServer? = null
    /** Echo guards for automatic clipboard sending: text that just arrived from another device / was just sent. */
    @Volatile internal var lastRemoteClip = ""
    @Volatile internal var lastSentClip = ""
    @Volatile internal var ignoreClipUntil = 0L
    internal val byId = ConcurrentHashMap<String, WebSocket>()
    internal val connInfo = ConcurrentHashMap<WebSocket, Peer>()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized
    fun ensureStarted(ctx: Context) {
        if (started) return
        started = true
        appCtx = ctx.applicationContext
        prefs = appCtx.getSharedPreferences("yconnect", Context.MODE_PRIVATE)
        myId = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).apply() }
        val s = HubSettings(
            prefs.getString("name", null) ?: Build.MODEL ?: "Android",
            prefs.getBoolean("clip", true),
            prefs.getBoolean("notif", true),
            prefs.getBoolean("files", true),
            prefs.getString("theme", "system") ?: "system",
            prefs.getBoolean("syscolors", false),
            prefs.getBoolean("battery", true),
            prefs.getBoolean("autoclip", false),
            prefs.getBoolean("sharestorage", false),
            prefs.getBoolean("storagewrite", false),
            prefs.getBoolean("allowcontrol", false),
        )
        settings.value = s
        RemoteCommands.load(appCtx)
        prefs.edit().remove("pass").remove("ignored").apply() // the single shared code of earlier versions is gone: every pair has its own code now
        try {
            val o = JSONObject(prefs.getString("pairs", "{}") ?: "{}")
            for (id in o.keys()) {
                val d = o.getJSONObject(id)
                val c = d.optString("code")
                if (Crypto.validCode(c)) { pairCodes[id] = c; pairNames[id] = d.optString("name", "Device") }
            }
        } catch (_: Exception) {}
        appCtx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("remote", "Notifications from your other devices", NotificationManager.IMPORTANCE_HIGH)
        )
        // Everything slow runs off the main thread so the first frame is not delayed:
        // the key derivation (PBKDF2, 100,000 rounds per paired device), file clean-up, sockets and the battery receiver.
        thread(isDaemon = true, name = "yconnect-init") {
            try {
                for ((id, code) in pairCodes) pairKeys.putIfAbsent(id, Crypto.deriveKey(code))
                Transfers.cleanOldPartials()
                addLog("info", "Device info", DeviceInfo.summary())
                try {
                    val wifi = appCtx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                    wifi.createMulticastLock("yconnect").apply { setReferenceCounted(false); acquire() }
                } catch (_: Exception) {}
                startServer()
                startDiscovery()
                startBattery()
                Latency.start()
            } catch (e: Exception) {
                addLog("warn", "Start-up problem", e.message ?: e.javaClass.simpleName)
            }
            main.post { ClipboardWatcher.refresh(appCtx) }
        }
    }

    fun updateSettings(n: HubSettings) {
        val old = settings.value
        prefs.edit().putString("name", n.name)
            .putBoolean("clip", n.clipboardSync).putBoolean("notif", n.notifySync)
            .putBoolean("files", n.acceptFiles).putString("theme", n.theme)
            .putBoolean("syscolors", n.systemColors).putBoolean("battery", n.batterySync)
            .putBoolean("autoclip", n.autoClipboard)
            .putBoolean("sharestorage", n.shareStorage).putBoolean("storagewrite", n.storageWrite).putBoolean("allowcontrol", n.allowControl).apply()
        settings.value = n
        if (old.allowControl && !n.allowControl) Screen.setControl(false, true) // turning the setting off ends control right away
        main.post { ClipboardWatcher.refresh(appCtx) }
        if (!old.batterySync && n.batterySync) sendBattery(null)
        if (old.name != n.name) {
            broadcastJson(helloJson())
        }
    }

    /* ---------- sockets ---------- */
    private fun startServer() {
        try {
            server = HubServer(WS_PORT).also { it.start() }
        } catch (e: Exception) {
            addLog("warn", "Server error", e.message ?: "could not open port $WS_PORT")
        }
    }

    /** [id] = a paired device we know (connect with its key); null = an address typed in by hand (ask who is there first). */
    fun connectTo(host: String, port: Int = WS_PORT, id: String? = null) = dial(host, port, if (id == null) "probe" else "connect", id, null)

    private fun dial(host: String, port: Int, mode: String, id: String?, name: String?) {
        val tag = "$host:$port"
        if (!connecting.add(tag)) { if (mode == "pair" && id != null) pairFail(id); return }
        thread(isDaemon = true, name = "y-connect") {
            try {
                val c = HubClient(URI("ws://$host:$port"), tag)
                conns[c] = ConnState(mode, id)
                clientInfo[c] = name ?: ""
                if (!c.connectBlocking(4, TimeUnit.SECONDS)) {
                    connecting.remove(tag)
                    conns.remove(c); clientInfo.remove(c)
                    try { c.close() } catch (_: Exception) {}
                    if (mode == "pair" && id != null) pairFail(id)
                }
            } catch (e: Exception) {
                connecting.remove(tag)
                if (mode == "pair" && id != null) pairFail(id)
            }
        }
    }
    private val clientInfo = ConcurrentHashMap<WebSocket, String>()
    private fun pairFail(id: String) {
        val po = pairOut.value
        if (po != null && po.id == id && po.state == "waiting" && pairOutConn == null) pairOut.value = po.copy(state = "failed")
    }

    private fun helloJson() = JSONObject().put("type", "hello").put("id", myId)
        .put("name", settings.value.name).put("platform", "android")

    // Pairing frames (and "who are you" probes) are plain JSON. Everything else is base64 AES-GCM, which never starts with "{".
    private fun sendRaw(conn: WebSocket, j: JSONObject) { try { if (conn.isOpen) conn.send(j.toString()) } catch (_: Exception) {} }

    internal fun sendJson(conn: WebSocket, j: JSONObject) {
        val k = keyFor(conn) ?: return
        try { if (conn.isOpen) conn.send(Crypto.encrypt(k, j.toString())) } catch (_: Exception) {}
    }

    private fun broadcastJson(j: JSONObject): Int {
        val text = j.toString()
        var n = 0
        for (c in connInfo.keys) {
            val k = keyFor(c) ?: continue
            if (c.isOpen) { try { c.send(Crypto.encrypt(k, text)); n++ } catch (_: Exception) {} }
        }
        return n
    }

    private fun sayHello(conn: WebSocket) { st(conn).helloSent = true; sendJson(conn, helloJson()) }

    /** A socket that never becomes a connected device (or finishes pairing) is closed. */
    private fun watchdog(conn: WebSocket) {
        main.postDelayed({ if (!connInfo.containsKey(conn)) { try { conn.close() } catch (_: Exception) {} } }, 60_000)
    }

    /** Someone connected to us. */
    internal fun onSocketOpen(conn: WebSocket) { st(conn); watchdog(conn) }

    /** We connected to someone: what happens first depends on why we dialled. */
    internal fun onClientOpen(conn: WebSocket) {
        val s = st(conn)
        watchdog(conn)
        when (s.mode) {
            "connect" -> {
                val id = s.peerId
                val k = id?.let { pairKeys[it] }
                if (id == null || k == null) { try { conn.close() } catch (_: Exception) {}; return }
                s.key = k; sayHello(conn)
            }
            "pair" -> startPairOut(conn, s.peerId ?: "", clientInfo[conn] ?: "Device")
            else -> sendRaw(conn, JSONObject().put("t", "who"))
        }
    }

    internal fun onSocketClosed(conn: WebSocket) {
        Transfers.onDisconnected(conn)
        Screen.onDisconnected(conn) // must run before connInfo forgets who this was
        RemoteCommands.onDisconnected(conn) // must run before connInfo forgets who this was
        if (pairReqConn === conn) { pairReqConn = null; pairRequest.value = null }
        if (pairOutConn === conn) { pairOutConn = null; pairOut.value?.let { if (it.state == "waiting") pairOut.value = it.copy(state = "failed") } }
        conns.remove(conn); clientInfo.remove(conn)
        val p = connInfo.remove(conn) ?: return
        byId.remove(p.id, conn)
        if (!byId.containsKey(p.id)) StorageShare.onDisconnected(p.id)
        if (!byId.containsKey(p.id)) Latency.drop(p.id)
        publishPeers()
        addLog("link", "Disconnected", p.name)
    }

    internal fun onSocketMessage(conn: WebSocket, raw: String) {
        if (raw.startsWith("{")) { onPlain(conn, raw); return }
        val s = st(conn)
        val j: JSONObject
        if (s.key == null) {
            // first encrypted frame on a socket someone opened to us: whose key opens it tells us which paired device it is
            var who: String? = null
            var parsed: JSONObject? = null
            for ((id, k) in pairKeys) { try { parsed = JSONObject(Crypto.decrypt(k, raw)); who = id; break } catch (_: Exception) {} }
            if (who == null || parsed == null) {
                sendRaw(conn, JSONObject().put("t", "unknown"))
                thread(isDaemon = true) { Thread.sleep(300); try { conn.close() } catch (_: Exception) {} }
                return
            }
            s.peerId = who; s.key = pairKeys[who]; j = parsed
        } else {
            j = try {
                JSONObject(Crypto.decrypt(s.key!!, raw))
            } catch (e: Exception) {
                // Not decryptable: drop it silently. An unknown socket is closed; an already connected peer stays connected.
                if (!connInfo.containsKey(conn)) { try { conn.close() } catch (_: Exception) {} }
                return
            }
        }
        if (j.optString("type").startsWith("file-")) {
            if (connInfo.containsKey(conn)) Transfers.onMessage(conn, j)
            return
        }
        if (j.optString("type").startsWith("screen-")) {
            if (connInfo.containsKey(conn)) Screen.onMessage(conn, j)
            return
        }
        if (j.optString("type").startsWith("fs-")) {
            if (connInfo.containsKey(conn)) StorageShare.onMessage(conn, j)
            return
        }
        if (j.optString("type").startsWith("cmd-")) {
            if (connInfo.containsKey(conn)) RemoteCommands.onMessage(conn, j)
            return
        }
        when (j.optString("type")) {
            "hello" -> {
                val id = j.optString("id")
                if (id.isEmpty() || id == myId || id != s.peerId) { conn.close(); return } // the key proves who it is
                val old = byId.put(id, conn)
                val isNew = !connInfo.containsKey(conn)
                if (old != null && old !== conn) { connInfo.remove(old); try { old.close() } catch (_: Exception) {} }
                val peer = Peer(id, j.optString("name", "Device"), j.optString("platform", "?"),
                    conn.remoteSocketAddress?.address?.hostAddress ?: "?")
                connInfo[conn] = peer
                pairNames[id]?.let { if (it != peer.name) { pairNames[id] = peer.name; savePairs() } }
                if (!s.helloSent) sayHello(conn)
                waitingSince.remove(id)
                if (pairOut.value?.id == id) pairOut.value = null
                publishPeers()
                if (isNew) { addLog("link", "Connected", peer.name); Latency.reset(id); Latency.ping(id); Transfers.onPeerConnected(id) }
                sendBattery(conn)
            }
            "ping" -> if (connInfo.containsKey(conn) && j.has("n")) sendJson(conn, JSONObject().put("type", "pong").put("n", j.optLong("n")))
            "pong" -> connInfo[conn]?.let { p -> if (j.has("n")) Latency.onPong(p.id, j.optLong("n")) }
            "battery" -> connInfo[conn]?.let { p ->
                val lv = j.optInt("level", -1)
                if (settings.value.batterySync && lv in 0..100) {
                    connInfo[conn] = p.copy(battery = lv, charging = j.optBoolean("charging"))
                    publishPeers()
                }
            }
            "unpair" -> connInfo[conn]?.let { p ->
                forgetPair(p.id)
                Transfers.dropQueue(p.id)
                addLog("link", "Unpaired by", p.name)
                try { conn.close() } catch (_: Exception) {}
            }
            "clipboard" -> if (connInfo.containsKey(conn) && settings.value.clipboardSync) {
                val t = j.optString("text")
                if (t.isNotEmpty() && t.length <= 1_000_000) {
                    lastRemoteClip = t
                    ignoreClipUntil = System.currentTimeMillis() + 2000
                    main.post {
                        try {
                            (appCtx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                                .setPrimaryClip(ClipData.newPlainText("Y Connect", t))
                        } catch (_: Exception) {}
                    }
                    addLog("clip", "Clipboard received", preview(t))
                }
            }
            "notification" -> if (connInfo.containsKey(conn) && settings.value.notifySync) {
                showRemoteNotification(j.optString("app"), j.optString("title"), j.optString("text"), j.optString("icon"))
            }
        }
    }

    private fun publishPeers() {
        peers.value = connInfo.values.sortedBy { it.name }
        pairRequest.value?.let { r -> if (byId.containsKey(r.id)) pairRequest.value = null }
        publishNearby()
    }

    /* ---------- battery ---------- */
    private var myBattery: Pair<Int, Boolean>? = null // level %, charging

    private fun readBattery(i: Intent?): Pair<Int, Boolean>? {
        if (i == null) return null
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return null
        val st = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return Pair(level * 100 / scale, st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL)
    }

    /** Listens for battery changes (system broadcast, no permission needed) and tells the connected devices. */
    private fun startBattery() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val b = readBattery(i) ?: return
                if (b != myBattery) { myBattery = b; sendBattery(null) }
            }
        }
        try {
            val sticky = ContextCompat.registerReceiver(appCtx, receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
            myBattery = readBattery(sticky)
        } catch (_: Exception) {}
    }

    /** Sends our battery to one device, or to every connected device when [conn] is null. */
    internal fun sendBattery(conn: WebSocket?) {
        val b = myBattery ?: return
        if (!settings.value.batterySync) return
        val j = JSONObject().put("type", "battery").put("level", b.first).put("charging", b.second)
        if (conn != null) sendJson(conn, j) else broadcastJson(j)
    }

    /* ---------- outgoing ---------- */
    /** Returns the number of devices it was sent to. */
    fun sendClipboard(text: String): Int {
        if (text.isEmpty() || text.length > 1_000_000) return 0
        lastSentClip = text
        val n = broadcastJson(JSONObject().put("type", "clipboard").put("text", text).put("ts", System.currentTimeMillis()))
        if (n > 0) addLog("clip", "Clipboard sent", preview(text))
        return n
    }

    private val recentNotifs = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private fun freshNotif(key: String, ttl: Long): Boolean {
        val now = System.currentTimeMillis()
        recentNotifs.entries.removeIf { now - it.value > 30_000 }
        val last = recentNotifs.put(key, now)
        return last == null || now - last >= ttl
    }

    fun sendNotification(app: String, title: String, text: String, icon: String = "") {
        if (!settings.value.notifySync || connInfo.isEmpty()) return
        if (!freshNotif("out|$app|$title|$text", 4000)) return // updates of the same notification must not repeat
        val sent = broadcastJson(JSONObject().put("type", "notification").put("app", app)
            .put("title", title).put("text", text).put("icon", icon).put("ts", System.currentTimeMillis()))
        if (sent > 0) addLog("notif", "Notification sent", (if (app.isNotEmpty()) "$app: " else "") + title.ifEmpty { text })
    }

    private fun showRemoteNotification(app: String, title: String, text: String, icon: String = "") {
        if (!freshNotif("in|$app|$title|$text", 3000)) return
        try {
            val n = NotificationCompat.Builder(appCtx, "remote")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title.ifEmpty { app.ifEmpty { "Notification" } })
                .setContentText(text)
                .setSubText(app.ifEmpty { null })
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .apply {
                    if (icon.isNotEmpty() && icon.length < 300_000) {
                        try {
                            val b = android.util.Base64.decode(icon, android.util.Base64.DEFAULT)
                            android.graphics.BitmapFactory.decodeByteArray(b, 0, b.size)?.let { setLargeIcon(it) }
                        } catch (_: Exception) {}
                    }
                }
                .build()
            appCtx.getSystemService(NotificationManager::class.java)
                .notify((System.currentTimeMillis() % 100000).toInt() + 100, n)
        } catch (_: Exception) {}
        addLog("notif", app.ifEmpty { "Notification" }, "$title $text".trim())
    }

    /* ---------- discovery ---------- */
    private fun startDiscovery() {
        thread(isDaemon = true, name = "yconnect-udp-rx") {
            try {
                val s = DatagramSocket(null)
                s.reuseAddress = true
                s.broadcast = true
                s.bind(InetSocketAddress(UDP_PORT))
                val buf = ByteArray(2048)
                while (!s.isClosed) {
                    val p = DatagramPacket(buf, buf.size)
                    s.receive(p)
                    onBeacon(p)
                }
            } catch (e: Exception) {
                addLog("warn", "Discovery error", e.message ?: "")
            }
        }
        thread(isDaemon = true, name = "yconnect-udp-tx") {
            try {
                val s = DatagramSocket()
                s.broadcast = true
                while (true) {
                    localIps.value = ownIps()
                    publishNearby() // drop devices that stopped announcing
                    val msg = JSONObject().put("app", "yconnect").put("id", myId)
                        .put("name", settings.value.name).put("platform", "android").put("port", WS_PORT).toString().toByteArray()
                    for (t in broadcastTargets()) {
                        try { s.send(DatagramPacket(msg, msg.size, t, UDP_PORT)) } catch (_: Exception) {}
                    }
                    Thread.sleep(3000)
                }
            } catch (_: Exception) {}
        }
    }

    private fun clean(v: String, max: Int) = v.filter { it >= ' ' }.take(max)

    private fun onBeacon(p: DatagramPacket) {
        try {
            val j = JSONObject(String(p.data, 0, p.length))
            if (j.optString("app") != "yconnect") return
            val id = clean(j.getString("id"), 64)
            if (id.isEmpty() || id == myId) return
            val addr = p.address.hostAddress ?: return
            if (j.optString("type").isNotEmpty()) return // pairing runs over the WebSocket now; other types come from newer versions
            val port = j.optInt("port", WS_PORT)
            nearbyMap[id] = NearbyEntry(
                id, clean(j.optString("name"), 40).ifEmpty { "Device" },
                clean(j.optString("platform"), 16).ifEmpty { "device" }, addr, port, System.currentTimeMillis()
            )
            publishNearby()
            if (byId.containsKey(id)) { waitingSince.remove(id); return }
            if (!pairKeys.containsKey(id)) return // not paired: it only shows up under Nearby
            // the device with the smaller id dials, so two devices never connect to each other twice.
            // If the smaller one stays silent for a while (it forgot this pair), the other one dials too and learns that.
            val now = System.currentTimeMillis()
            val since = waitingSince.getOrPut(id) { now }
            if (myId < id || now - since > 9000) connectTo(addr, port, id)
        } catch (_: Exception) {}
    }

    /* ---------- nearby devices & pairing ---------- */
    internal fun publishNearby() {
        val now = System.currentTimeMillis()
        nearbyMap.entries.removeIf { now - it.value.seen > NEARBY_TTL }
        nearby.value = nearbyMap.values.filter { !byId.containsKey(it.id) }
            .map { Nearby(it.id, it.name, it.platform, it.address) }.sortedBy { it.name.lowercase() }
    }

    /** Asks the nearby device [id] to pair. Returns its name, or null when it is no longer visible. */
    fun requestPair(id: String): String? {
        val n = nearbyMap[id] ?: return null
        pairOut.value = PairOut(id, n.name, "", "waiting")
        dial(n.address, n.port, "pair", id, n.name)
        return n.name
    }

    fun cancelPair() {
        val c = pairOutConn
        pairOutConn = null
        pairOut.value = null
        if (c != null) try { c.close() } catch (_: Exception) {}
    }

    /** Disconnects [id] and tells it to forget us too, so neither side reconnects on its own. */
    fun unpair(id: String) {
        val conn = byId[id] ?: return
        val name = connInfo[conn]?.name ?: "Device"
        sendJson(conn, JSONObject().put("type", "unpair"))
        thread(isDaemon = true, name = "yconnect-unpair") {
            Thread.sleep(150)
            try { conn.close() } catch (_: Exception) {}
        }
        forgetPair(id)
        Transfers.dropQueue(id)
        addLog("link", "Unpaired", name)
    }

    /* ---- pairing, the device that asks ---- */
    private fun startPairOut(conn: WebSocket, id: String, name: String) {
        pairOutConn?.let { if (it !== conn) try { it.close() } catch (_: Exception) {} }
        val kp = Crypto.newKeyPair()
        st(conn).pair = PairSess("out", id, name, kp.pair.private, kp.pubB64)
        pairOutConn = conn
        pairOut.value = PairOut(id, name, "", "waiting")
        sendRaw(conn, JSONObject().put("t", "pair-req").put("id", myId).put("name", settings.value.name)
            .put("platform", "android").put("pub", kp.pubB64))
        addLog("info", "Pairing started", "Waiting for $name to accept")
    }

    /* ---- pairing, the device that is asked ---- */
    private fun onPairReq(conn: WebSocket, m: JSONObject) {
        val s = st(conn)
        val id = clean(m.optString("id"), 64)
        if (id.isEmpty() || id == myId || s.pair != null || connInfo.containsKey(conn)) return
        val po = pairOut.value
        if (po != null && po.id == id && po.state == "waiting") {
            // both devices asked each other at the same moment: the one with the smaller id keeps its own request
            if (myId < id) { sendRaw(conn, JSONObject().put("t", "pair-decline")); try { conn.close() } catch (_: Exception) {}; return }
            cancelPair()
        }
        if (pairRequest.value != null) { sendRaw(conn, JSONObject().put("t", "pair-decline")); try { conn.close() } catch (_: Exception) {}; return } // one question at a time
        val kp = Crypto.newKeyPair()
        val theirPub = m.optString("pub")
        val secret = try { Crypto.agree(kp.pair.private, theirPub) } catch (_: Exception) { try { conn.close() } catch (_: Exception) {}; return }
        val name = clean(m.optString("name"), 40).ifEmpty { "Device" }
        s.pair = PairSess("in", id, name, null, kp.pubB64, secret)
        pairReqConn = conn
        pairRequest.value = PairRequest(id, name, conn.remoteSocketAddress?.address?.hostAddress ?: "?", Crypto.checkNumber(secret, theirPub, kp.pubB64))
        sendRaw(conn, JSONObject().put("t", "pair-pub").put("pub", kp.pubB64))
        addLog("info", "Pairing request", "$name wants to pair")
        notifyPairRequest(name)
    }

    fun acceptPair(): Boolean {
        val r = pairRequest.value
        val c = pairReqConn
        pairRequest.value = null
        pairReqConn = null // the socket stays open: the pairing code arrives on it next
        if (r == null || c == null || !c.isOpen) return false
        st(c).pair?.accepted = true
        sendRaw(c, JSONObject().put("t", "pair-accept"))
        addLog("info", "Pairing accepted", r.name)
        return true
    }

    fun declinePair() {
        val r = pairRequest.value
        val c = pairReqConn
        pairRequest.value = null
        pairReqConn = null
        if (c != null) {
            sendRaw(c, JSONObject().put("t", "pair-decline"))
            thread(isDaemon = true) { Thread.sleep(200); try { c.close() } catch (_: Exception) {} }
            if (r != null) addLog("info", "Pairing declined", r.name)
        }
    }

    private fun closeQuietly(c: WebSocket) { try { c.close() } catch (_: Exception) {} }

    /** Plain (unencrypted) frames: only pairing, and finding out who is behind an address. */
    private fun onPlain(conn: WebSocket, raw: String) {
        if (connInfo.containsKey(conn)) return
        val m = try { JSONObject(raw) } catch (_: Exception) { return }
        val s = st(conn)
        when (m.optString("t")) {
            "who" -> sendRaw(conn, JSONObject().put("t", "iam").put("id", myId).put("name", settings.value.name).put("platform", "android"))
            "iam" -> { // answer to our probe: known device -> connect, new device -> ask it to pair
                if (s.mode != "probe") return
                val id = clean(m.optString("id"), 64)
                if (id.isEmpty() || id == myId) { closeQuietly(conn); return }
                if (pairKeys.containsKey(id)) { s.mode = "connect"; s.peerId = id; s.key = pairKeys[id]; sayHello(conn) }
                else { s.mode = "pair"; startPairOut(conn, id, clean(m.optString("name"), 40).ifEmpty { "Device" }) }
            }
            "unknown" -> { // the device we dialled does not know us (it was unpaired there): forget it here too
                val id = s.peerId
                if (s.mode == "connect" && id != null) {
                    val name = pairNames[id] ?: "A device"
                    forgetPair(id); Transfers.dropQueue(id)
                    addLog("link", "No longer paired", "$name no longer recognises this device. Pair again to reconnect.")
                    closeQuietly(conn)
                }
            }
            "pair-req" -> onPairReq(conn, m)
            "pair-pub" -> { // out: the other device sent its half of the key exchange
                val p = s.pair ?: return
                val priv = p.priv
                if (p.role != "out" || p.secret != null || priv == null) return
                val theirPub = m.optString("pub")
                val sec = try { Crypto.agree(priv, theirPub) } catch (_: Exception) { closeQuietly(conn); return }
                p.secret = sec
                pairOut.value?.let { if (pairOutConn === conn) pairOut.value = it.copy(sas = Crypto.checkNumber(sec, p.pub, theirPub)) }
            }
            "pair-decline" -> {
                if (s.pair?.role == "out" && pairOutConn === conn) {
                    pairOut.value?.let { pairOut.value = it.copy(state = "declined") }
                    pairOutConn = null
                    addLog("info", "Pairing declined", "${s.pair?.name ?: "Device"} declined")
                }
                closeQuietly(conn)
            }
            "pair-accept" -> { // out: the other user tapped Accept -> create this pair's random code and hand it over
                val p = s.pair ?: return
                val sec = p.secret
                if (p.role != "out" || sec == null || p.sent || pairOutConn !== conn) return
                p.sent = true
                val code = Crypto.randomCode()
                sendRaw(conn, JSONObject().put("t", "pair-code").put("d", Crypto.encrypt(Crypto.transportKey(sec), code)))
                storePair(p.id, p.name, code)
                s.peerId = p.id; s.key = pairKeys[p.id]
                sayHello(conn)
                addLog("info", "Paired", p.name)
            }
            "pair-code" -> { // in: we accepted, now the code arrives
                val p = s.pair ?: return
                val sec = p.secret
                if (p.role != "in" || !p.accepted || sec == null || p.done) return
                val code = try { Crypto.decrypt(Crypto.transportKey(sec), m.optString("d")) } catch (_: Exception) { closeQuietly(conn); return }
                if (!Crypto.validCode(code)) { closeQuietly(conn); return }
                p.done = true
                storePair(p.id, p.name, code)
                s.peerId = p.id; s.key = pairKeys[p.id]
                addLog("info", "Paired", p.name)
            }
        }
    }

    private fun notifyPairRequest(name: String) {
        try {
            val open = PendingIntent.getActivity(
                appCtx, 7, Intent(appCtx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val n = NotificationCompat.Builder(appCtx, "remote")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("$name wants to pair")
                .setContentText("Open Y Connect to accept or decline")
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            appCtx.getSystemService(NotificationManager::class.java).notify(7001, n)
        } catch (_: Exception) {}
    }

    private fun broadcastTargets(): List<InetAddress> {
        val out = mutableListOf(InetAddress.getByName("255.255.255.255"))
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) ia.broadcast?.let { out.add(it) }
            }
        } catch (_: Exception) {}
        return out
    }

    private fun ownIps(): List<String> {
        val out = mutableListOf<String>()
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in Collections.list(ni.inetAddresses)) {
                    if (a is Inet4Address && !a.isLoopbackAddress) a.hostAddress?.let { out.add(it) }
                }
            }
        } catch (_: Exception) {}
        return out
    }

    /* ---------- log ---------- */
    private fun preview(t: String) = t.replace(Regex("\\s+"), " ").take(60)

    @Synchronized
    fun addLog(kind: String, title: String, text: String = "") {
        val cur = log.value
        val top = cur.firstOrNull()
        log.value = if (top != null && top.kind == kind && top.title == title && top.text == text)
            listOf(top.copy(time = System.currentTimeMillis(), count = top.count + 1)) + cur.drop(1)
        else (listOf(LogEntry(System.currentTimeMillis(), kind, title, text)) + cur).take(50)
    }
}

internal class HubServer(port: Int) : WebSocketServer(InetSocketAddress(port)) {
    init {
        isReuseAddr = true
        connectionLostTimeout = 20
    }
    override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) = Hub.onSocketOpen(conn)
    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) = Hub.onSocketClosed(conn)
    override fun onMessage(conn: WebSocket, message: String) = Hub.onSocketMessage(conn, message)
    override fun onMessage(conn: WebSocket, message: ByteBuffer) = Transfers.onBinary(conn, message)
    override fun onError(conn: WebSocket?, ex: Exception?) {
        if (conn == null) Hub.addLog("warn", "Server error", ex?.message ?: "")
    }
    override fun onStart() {}
}

internal class HubClient(uri: URI, private val tag: String) : WebSocketClient(uri) {
    init { connectionLostTimeout = 20 }
    override fun onOpen(handshakedata: ServerHandshake?) = Hub.onClientOpen(this)
    override fun onMessage(message: String) = Hub.onSocketMessage(this, message)
    override fun onMessage(bytes: ByteBuffer) = Transfers.onBinary(this, bytes)
    override fun onClose(code: Int, reason: String?, remote: Boolean) {
        Hub.connecting.remove(tag)
        Hub.onSocketClosed(this)
    }
    override fun onError(ex: Exception?) {}
}
