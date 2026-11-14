// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.flow.MutableStateFlow
import org.java_websocket.WebSocket
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference

/**
 * Screen sharing over the encrypted connection, in both directions, optionally with remote control. Same protocol as desktop/screen.js:
 *   screen-start {sid,w,h}  ->  binary frames AES-GCM( uint32 0 + uint32 sid + JPEG )  ->  screen-stop {sid}
 * Control (off unless the sharer allows it in its settings): screen-start may carry ctl:true, the sharer can switch it with
 * screen-ctl {sid,on}, and the viewer sends screen-input {sid, ev} (coordinates 0..1 of the picture, see desktop/inputctl.js).
 * Phones inject input through [RemoteControlService] (an accessibility service the user enables by hand).
 * File-transfer ids are never 0, so tid 0 marks a screen picture; older versions ignore those frames.
 * Sharing = [ScreenShareService] (MediaProjection). Watching = [ScreenViewActivity].
 */
object Screen {
    data class State(val sharingTo: String? = null, val viewing: String? = null)
    val state = MutableStateFlow(State())

    interface Listener { fun onPicture(); fun onEnded(); fun onControl() {} }

    // ---- watching the other device
    @Volatile var viewConn: WebSocket? = null
    @Volatile private var viewSid = 0L
    @Volatile var viewName = ""
    /** The other device lets us control it (we may send screen-input). */
    @Volatile var viewCtl = false
    @Volatile var listener: Listener? = null
    private val latest = AtomicReference<ByteArray?>(null)
    fun takePicture(): ByteArray? = latest.getAndSet(null)
    fun hasPicture(): Boolean = latest.get() != null

    // ---- sharing this phone's screen (set by ScreenShareService)
    @Volatile var shareConn: WebSocket? = null
    @Volatile var shareSid = 0L
    /** This phone lets the viewer control it right now. */
    @Volatile var controlOn = false
    private var bucket = 400.0
    private var bucketAt = System.currentTimeMillis()
    private const val RATE = 400.0 // input events per second a viewer may send

    /** True when the user allowed control in the settings and the accessibility service is running. */
    fun canControl(): Boolean = Hub.settings.value.allowControl && RemoteControlService.instance != null

    /** The sharer switches control on / off while sharing (the "Stop control" button, or the setting being turned off). */
    fun setControl(on: Boolean, notify: Boolean) {
        val conn = shareConn ?: return
        val now = on && canControl()
        if (controlOn == now) return
        controlOn = now
        if (!now) RemoteControlService.instance?.releaseAll()
        if (notify) Hub.sendJson(conn, JSONObject().put("type", "screen-ctl").put("sid", shareSid).put("on", now))
        Hub.addLog("info", if (now) "Remote control on" else "Remote control off", "")
        ScreenShareService.refreshNotification(Hub.appCtx)
    }

    /** Viewer side: sends one mouse / keyboard event to the device we are watching. */
    fun sendInput(ev: JSONObject) {
        val c = viewConn ?: return
        if (!viewCtl) return
        Hub.sendJson(c, JSONObject().put("type", "screen-input").put("sid", viewSid).put("ev", ev))
    }

    private const val NOTE_ID = 3

    fun onMessage(conn: WebSocket, j: JSONObject) {
        val peer = Hub.connInfo[conn] ?: return
        val sid = j.optLong("sid", 0L)
        if (sid <= 0L) return
        when (j.optString("type")) {
            "screen-start" -> {
                viewConn = conn; viewSid = sid; viewName = peer.name
                viewCtl = j.optBoolean("ctl", false)
                latest.set(null)
                state.value = state.value.copy(viewing = peer.id)
                Hub.addLog("info", "Watching screen", peer.name)
                announce(Hub.appCtx, peer.name)
            }
            "screen-ctl" -> if (conn === viewConn && sid == viewSid) { viewCtl = j.optBoolean("on", false); listener?.onControl() }
            "screen-input" -> {
                if (conn !== shareConn || sid != shareSid || !controlOn) return
                val now = System.currentTimeMillis()
                bucket = minOf(RATE, bucket + (now - bucketAt) * RATE / 1000.0); bucketAt = now
                if (bucket < 1.0) return
                bucket -= 1.0
                RemoteControlService.instance?.handle(j.optJSONObject("ev") ?: return)
            }
            "screen-stop" -> {
                if (conn === viewConn && sid == viewSid) endViewing(false)
                if (conn === shareConn && sid == shareSid) ScreenShareService.stop(Hub.appCtx) // the viewer closed its window
            }
        }
    }

    /** [plain] = uint32 0 + uint32 sid + JPEG, already decrypted. */
    fun onFrame(conn: WebSocket, plain: ByteArray) {
        if (conn !== viewConn || plain.size < 9 || plain.size > 6 * 1024 * 1024) return
        val sid = ((plain[4].toLong() and 0xff) shl 24) or ((plain[5].toLong() and 0xff) shl 16) or
            ((plain[6].toLong() and 0xff) shl 8) or (plain[7].toLong() and 0xff)
        if (sid != viewSid) return
        latest.set(plain.copyOfRange(8, plain.size)) // only the newest picture is kept: the viewer never lags behind
        listener?.onPicture()
    }

    /** The user left the viewer (tell the other device), or the other device / the connection ended it. */
    fun endViewing(notify: Boolean) {
        val conn = viewConn ?: return
        val sid = viewSid
        viewConn = null; viewSid = 0L; viewCtl = false
        latest.set(null)
        if (notify) Hub.sendJson(conn, JSONObject().put("type", "screen-stop").put("sid", sid))
        state.value = state.value.copy(viewing = null)
        try { Hub.appCtx.getSystemService(NotificationManager::class.java).cancel(NOTE_ID) } catch (_: Exception) {}
        listener?.onEnded()
    }

    fun onDisconnected(conn: WebSocket) {
        if (conn === viewConn) endViewing(false)
        if (conn === shareConn) ScreenShareService.stop(Hub.appCtx)
    }

    /** Opens the viewer right away when the app is on screen, otherwise a notification takes the user there. */
    private fun announce(ctx: Context, name: String) {
        val open = Intent(ctx, ScreenViewActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (Latency.uiVisible) { try { ctx.startActivity(open) } catch (_: Exception) {} }
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("screen", "Screen sharing", NotificationManager.IMPORTANCE_HIGH))
        val pi = PendingIntent.getActivity(ctx, 3, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, "screen")
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("$name is sharing its screen")
            .setContentText("Tap to watch")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try { nm.notify(NOTE_ID, n) } catch (_: SecurityException) {}
    }
}
