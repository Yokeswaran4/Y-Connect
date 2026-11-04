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
    val passphrase: String,
    val clipboardSync: Boolean,
    val notifySync: Boolean,
    val acceptFiles: Boolean = true,
    val theme: String = "system", // system | light | dark
    val systemColors: Boolean = false, // Material You wallpaper colours (Android 12+); off = Y Connect desktop look (default)
    val batterySync: Boolean = true,  // share this phone's battery and show the other devices'
    val autoClipboard: Boolean = false, // send the phone's clipboard automatically (needs "Display over other apps")
)
data class Peer(val id: String, val name: String, val platform: String, val address: String, val battery: Int = -1, val charging: Boolean = false)
/** A device that has Y Connect open on this network but is not connected to us (yet). */
data class Nearby(val id: String, val name: String, val platform: String, val address: String)
/** Another device asked to pair: we should ask the user for the code shown on that device. */
data class PairRequest(val id: String, val name: String, val address: String)
data class LogEntry(val time: Long, val kind: String, val title: String, val text: String, val count: Int = 1)

/** Everything network-related lives here: WebSocket server + client, UDP discovery, message handling. */
object Hub {
    const val WS_PORT = 48998
    const val UDP_PORT = 48999

    val settings = MutableStateFlow(HubSettings("", "", true, true))
    val peers = MutableStateFlow<List<Peer>>(emptyList())
    val log = MutableStateFlow<List<LogEntry>>(emptyList())
    val localIps = MutableStateFlow<List<String>>(emptyList())
    val nearby = MutableStateFlow<List<Nearby>>(emptyList())
    val pairRequest = MutableStateFlow<PairRequest?>(null)

    private class NearbyEntry(val id: String, val name: String, val platform: String, val address: String, val port: Int, val seen: Long)
    private val nearbyMap = ConcurrentHashMap<String, NearbyEntry>()
    /** Devices that were unpaired: never auto-connect to them until the user pairs again. */
    private val ignored: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private fun saveIgnored() { prefs.edit().putStringSet("ignored", ignored.toSet()).apply() }
    private const val NEARBY_TTL = 10_000L

    internal val connecting: MutableSet<String> = ConcurrentHashMap.newKeySet()

    internal lateinit var appCtx: Context
    private lateinit var prefs: SharedPreferences
    internal lateinit var myId: String
    @Volatile internal var key = ByteArray(0)
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
            prefs.getString("pass", null) ?: randomCode().also { prefs.edit().putString("pass", it).apply() },
            prefs.getBoolean("clip", true),
            prefs.getBoolean("notif", true),
            prefs.getBoolean("files", true),
            prefs.getString("theme", "system") ?: "system",
            prefs.getBoolean("syscolors", false),
            prefs.getBoolean("battery", true),
            prefs.getBoolean("autoclip", false),
        )
        settings.value = s
        RemoteCommands.load(appCtx)
        ignored.addAll(prefs.getStringSet("ignored", emptySet()) ?: emptySet())
        appCtx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("remote", "Notifications from your other devices", NotificationManager.IMPORTANCE_HIGH)
        )
        // Everything slow runs off the main thread so the first frame is not delayed:
        // the key derivation (PBKDF2, 100,000 rounds), file clean-up, sockets and the battery receiver.
        thread(isDaemon = true, name = "yconnect-init") {
            try {
                val code = s.passphrase
                val k = Crypto.deriveKey(code)
                // the user may already have changed the code while this was running: then updateSettings() owns the key
                if (Crypto.normalize(settings.value.passphrase) == Crypto.normalize(code)) key = k
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

    private fun randomCode(): String {
        val a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val r = SecureRandom()
        val s = (1..8).map { a[r.nextInt(a.length)] }.joinToString("")
        return s.substring(0, 4) + "-" + s.substring(4)
    }

    fun updateSettings(n: HubSettings) {
        val old = settings.value
        prefs.edit().putString("name", n.name).putString("pass", n.passphrase)
            .putBoolean("clip", n.clipboardSync).putBoolean("notif", n.notifySync)
            .putBoolean("files", n.acceptFiles).putString("theme", n.theme)
            .putBoolean("syscolors", n.systemColors).putBoolean("battery", n.batterySync)
            .putBoolean("autoclip", n.autoClipboard).apply()
        settings.value = n
        main.post { ClipboardWatcher.refresh(appCtx) }
        if (!old.batterySync && n.batterySync) sendBattery(null)
        if (Crypto.normalize(old.passphrase) != Crypto.normalize(n.passphrase)) {
            ignored.clear(); saveIgnored() // a new code is a fresh start
            key = Crypto.deriveKey(n.passphrase)
            connInfo.keys.forEach { try { it.close() } catch (_: Exception) {} }
            addLog("info", "Pairing code changed", "Reconnecting…")
        } else if (old.name != n.name) {
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

    fun connectTo(host: String, port: Int = WS_PORT) {
        val tag = "$host:$port"
        if (!connecting.add(tag)) return
        thread(isDaemon = true, name = "y-connect") {
            try {
                val c = HubClient(URI("ws://$host:$port"), tag)
                if (!c.connectBlocking(4, TimeUnit.SECONDS)) {
                    connecting.remove(tag)
                    try { c.close() } catch (_: Exception) {}
                }
            } catch (e: Exception) {
                connecting.remove(tag)
            }
        }
    }

    private fun helloJson() = JSONObject().put("type", "hello").put("id", myId)
        .put("name", settings.value.name).put("platform", "android")

    internal fun sendJson(conn: WebSocket, j: JSONObject) {
        try { if (conn.isOpen) conn.send(Crypto.encrypt(key, j.toString())) } catch (_: Exception) {}
    }

    private fun broadcastJson(j: JSONObject): Int {
        val enc = Crypto.encrypt(key, j.toString())
        var n = 0
        for (c in connInfo.keys) if (c.isOpen) { try { c.send(enc); n++ } catch (_: Exception) {} }
        return n
    }

    internal fun onSocketOpen(conn: WebSocket) = sendJson(conn, helloJson())

    internal fun onSocketClosed(conn: WebSocket) {
        Transfers.onDisconnected(conn)
        RemoteCommands.onDisconnected(conn) // must run before connInfo forgets who this was
        val p = connInfo.remove(conn) ?: return
        byId.remove(p.id, conn)
        if (!byId.containsKey(p.id)) Latency.drop(p.id)
        publishPeers()
        addLog("link", "Disconnected", p.name)
    }

    internal fun onSocketMessage(conn: WebSocket, raw: String) {
        val j = try {
            JSONObject(Crypto.decrypt(key, raw))
        } catch (e: Exception) {
            // Not decryptable: drop it silently. An unknown socket is closed; an already connected peer stays connected.
            if (!connInfo.containsKey(conn)) { try { conn.close() } catch (_: Exception) {} }
            return
        }
        if (j.optString("type").startsWith("file-")) {
            if (connInfo.containsKey(conn)) Transfers.onMessage(conn, j)
            return
        }
        if (j.optString("type").startsWith("cmd-")) {
            if (connInfo.containsKey(conn)) RemoteCommands.onMessage(conn, j)
            return
        }
        when (j.optString("type")) {
            "hello" -> {
                val id = j.optString("id")
                if (id.isEmpty() || id == myId || ignored.contains(id)) { conn.close(); return }
                val old = byId.put(id, conn)
                val isNew = !connInfo.containsKey(conn)
                if (old != null && old !== conn) { connInfo.remove(old); try { old.close() } catch (_: Exception) {} }
                val peer = Peer(id, j.optString("name", "Device"), j.optString("platform", "?"),
                    conn.remoteSocketAddress?.address?.hostAddress ?: "?")
                connInfo[conn] = peer
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
                ignored.add(p.id); saveIgnored()
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
            when (j.optString("type")) {
                "pair-request" -> { onPairRequest(id, clean(j.optString("name"), 40), addr); return }
                "pair-cancel" -> { if (pairRequest.value?.id == id) pairRequest.value = null; return }
                "" -> {}
                else -> return // unknown message from a newer version
            }
            val port = j.optInt("port", WS_PORT)
            nearbyMap[id] = NearbyEntry(
                id, clean(j.optString("name"), 40).ifEmpty { "Device" },
                clean(j.optString("platform"), 16).ifEmpty { "device" }, addr, port, System.currentTimeMillis()
            )
            publishNearby()
            if (byId.containsKey(id) || ignored.contains(id)) return
            // the device with the smaller id dials, so two devices never connect to each other twice
            if (myId < id) connectTo(addr, port)
        } catch (_: Exception) {}
    }

    /* ---------- nearby devices & pairing ---------- */
    internal fun publishNearby() {
        val now = System.currentTimeMillis()
        nearbyMap.entries.removeIf { now - it.value.seen > NEARBY_TTL }
        nearby.value = nearbyMap.values.filter { !byId.containsKey(it.id) }
            .map { Nearby(it.id, it.name, it.platform, it.address) }.sortedBy { it.name.lowercase() }
    }

    private fun udpUnicast(msg: ByteArray, address: String, twice: Boolean) {
        thread(isDaemon = true, name = "yconnect-udp-pair") {
            try {
                DatagramSocket().use { s ->
                    val to = InetAddress.getByName(address)
                    s.send(DatagramPacket(msg, msg.size, to, UDP_PORT))
                    if (twice) { Thread.sleep(400); s.send(DatagramPacket(msg, msg.size, to, UDP_PORT)) } // UDP can drop packets
                }
            } catch (_: Exception) {}
        }
    }

    /** Tells [id] that we want to pair and returns (our pairing code, its name) to show on screen. The code never leaves this device. */
    fun sendPairRequest(id: String): Pair<String, String>? {
        val n = nearbyMap[id] ?: return null
        if (ignored.remove(id)) saveIgnored()
        val msg = JSONObject().put("app", "yconnect").put("type", "pair-request").put("id", myId)
            .put("name", settings.value.name).put("platform", "android").toString().toByteArray()
        udpUnicast(msg, n.address, true)
        addLog("info", "Pairing started", "Enter the code on ${n.name}")
        return settings.value.passphrase to n.name
    }

    fun cancelPairRequest(id: String) {
        val n = nearbyMap[id] ?: return
        val msg = JSONObject().put("app", "yconnect").put("type", "pair-cancel").put("id", myId).toString().toByteArray()
        udpUnicast(msg, n.address, false)
    }

    fun dismissPairRequest() { pairRequest.value = null }

    /** Disconnects [id] and tells it to forget us too, so neither side reconnects on its own. */
    fun unpair(id: String) {
        val conn = byId[id] ?: return
        val name = connInfo[conn]?.name ?: "Device"
        thread(isDaemon = true, name = "yconnect-unpair") {
            sendJson(conn, JSONObject().put("type", "unpair"))
            Thread.sleep(150)
            try { conn.close() } catch (_: Exception) {}
        }
        ignored.add(id); saveIgnored()
        Transfers.dropQueue(id)
        addLog("link", "Unpaired", name)
    }

    private fun onPairRequest(id: String, name: String, addr: String) {
        if (ignored.remove(id)) saveIgnored()
        if (byId.containsKey(id)) return
        if (pairRequest.value?.id == id) return // duplicate packet, already showing
        val n = name.ifEmpty { "Device" }
        pairRequest.value = PairRequest(id, n, addr)
        addLog("info", "Pairing request", "$n wants to pair")
        notifyPairRequest(n)
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
                .setContentText("Open Y Connect and enter the code shown on $name")
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
    override fun onOpen(handshakedata: ServerHandshake?) = Hub.onSocketOpen(this)
    override fun onMessage(message: String) = Hub.onSocketMessage(this, message)
    override fun onMessage(bytes: ByteBuffer) = Transfers.onBinary(this, bytes)
    override fun onClose(code: Int, reason: String?, remote: Boolean) {
        Hub.connecting.remove(tag)
        Hub.onSocketClosed(this)
    }
    override fun onError(ex: Exception?) {}
}
