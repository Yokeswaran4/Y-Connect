// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.Display
import androidx.core.app.NotificationCompat
import org.java_websocket.WebSocket
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Shares this phone's screen with one paired device. Needs the user's "Start recording or casting?" consent first
 * (MainActivity asks for it and hands the result over), runs as a foreground service so Android keeps it alive.
 */
class ScreenShareService : Service() {
    companion object {
        private const val ACTION_STOP = "stop"
        private const val ACTION_STOP_CTL = "stopctl"
        private const val MAX_DIM = 1280
        private const val FPS = 20
        private const val QUALITY = 50
        private const val BUSY_FRAME_MS = 1000L // an unchanged screen is re-sent at most once a second

        fun start(ctx: Context, resultCode: Int, data: Intent, peerId: String) {
            val i = Intent(ctx, ScreenShareService::class.java).putExtra("code", resultCode).putExtra("data", data).putExtra("peer", peerId)
            ctx.startForegroundService(i)
        }
        /** Re-posts the ongoing notification (e.g. after control was switched off). */
        fun refreshNotification(ctx: Context) {
            if (Screen.shareConn == null) return
            try { ctx.getSystemService(NotificationManager::class.java).notify(2, build(ctx)) } catch (_: Exception) {}
        }
        private fun build(ctx: Context): Notification {
            ctx.getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel("screenshare", "Screen sharing", NotificationManager.IMPORTANCE_LOW))
            val stop = PendingIntent.getService(ctx, 4, Intent(ctx, ScreenShareService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
            val open = PendingIntent.getActivity(ctx, 5, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            val b = NotificationCompat.Builder(ctx, "screenshare")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(if (Screen.controlOn) "Sharing and being controlled" else "Sharing your screen")
                .setContentText(if (Screen.controlOn) "Another device can see and control this screen" else "Another device can see this screen")
                .setContentIntent(open)
                .addAction(0, "Stop", stop)
                .setOngoing(true)
            if (Screen.controlOn) {
                val sc = PendingIntent.getService(ctx, 6, Intent(ctx, ScreenShareService::class.java).setAction(ACTION_STOP_CTL), PendingIntent.FLAG_IMMUTABLE)
                b.addAction(0, "Stop control", sc)
            }
            return b.build()
        }
        fun stop(ctx: Context) {
            try { ctx.startService(Intent(ctx, ScreenShareService::class.java).setAction(ACTION_STOP)) } catch (_: Exception) {}
        }
    }

    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var conn: WebSocket? = null
    private var sid = 0L
    private var peerId = ""
    private var w = 0
    private var h = 0
    private var bmp: Bitmap? = null
    private var lastSent = 0L
    private var lastPrint = 0
    @Volatile private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSharing(true); return START_NOT_STICKY }
        if (intent?.action == ACTION_STOP_CTL) { Screen.setControl(false, true); return START_NOT_STICKY }
        if (!running) Screen.controlOn = Screen.canControl() // decided once per session; announced in screen-start
        // started with startForegroundService(): Android requires startForeground() on every path, and a projection
        // may only be created after it (Android 14+)
        startForeground(2, notification(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        val code = intent?.getIntExtra("code", 0) ?: 0
        val data = intent?.getParcelableExtra<Intent>("data")
        val peer = intent?.getStringExtra("peer") ?: ""
        val c = Hub.byId[peer]
        if (running) return START_NOT_STICKY
        if (data == null || c == null || !c.isOpen) { stopSharing(false); return START_NOT_STICKY }
        try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            thread = HandlerThread("yconnect-screen").also { it.start() }
            handler = Handler(thread!!.looper)
            projection = mpm.getMediaProjection(code, data)?.also {
                it.registerCallback(object : MediaProjection.Callback() {
                    override fun onStop() { stopSharing(true) } // the user ended it from the system's status bar chip
                }, handler)
            }
            if (projection == null) throw IllegalStateException("no projection")
        } catch (e: Exception) {
            Hub.addLog("warn", "Screen sharing failed", e.message ?: "could not start")
            stopSharing(false)
            return START_NOT_STICKY
        }
        conn = c; peerId = peer
        sid = (Math.random() * 0x7fffffff).toLong() + 1
        running = true
        Screen.shareConn = c; Screen.shareSid = sid
        Screen.state.value = Screen.state.value.copy(sharingTo = peer)
        buildDisplay()
        Hub.sendJson(c, JSONObject().put("type", "screen-start").put("sid", sid).put("w", w).put("h", h).put("ctl", Screen.controlOn))
        Hub.addLog("info", "Sharing screen", "with " + (Hub.connInfo[c]?.name ?: "device"))
        return START_NOT_STICKY
    }

    private fun notification(): Notification = build(this)

    /** (Re)creates the virtual display at the current screen size; also used after a rotation. */
    private fun buildDisplay() {
        val p = projection ?: return
        @Suppress("DEPRECATION")
        val dm = DisplayMetrics().also { getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(it) }
        val k = min(1f, MAX_DIM.toFloat() / max(dm.widthPixels, dm.heightPixels))
        val nw = max(2, (dm.widthPixels * k).roundToInt()) and 1.inv()
        val nh = max(2, (dm.heightPixels * k).roundToInt()) and 1.inv()
        display?.release(); display = null
        reader?.close(); reader = null
        bmp = null
        w = nw; h = nh
        val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        r.setOnImageAvailableListener({ onImage(it) }, handler)
        reader = r
        display = p.createVirtualDisplay("yconnect-share", w, h, max(1, (dm.densityDpi * k).roundToInt()),
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, handler)
    }

    private fun onImage(r: ImageReader) {
        val img = try { r.acquireLatestImage() } catch (_: Exception) { null } ?: return
        try {
            val c = conn ?: return
            val now = System.currentTimeMillis()
            if (!running || !c.isOpen || now - lastSent < 1000 / FPS || c.hasBufferedData()) return // too soon, or the connection is busy
            val plane = img.planes[0]
            val pixel = plane.pixelStride
            val width = plane.rowStride / pixel
            var b = bmp
            if (b == null || b.width != width || b.height != img.height) { b = Bitmap.createBitmap(width, img.height, Bitmap.Config.ARGB_8888); bmp = b }
            plane.buffer.rewind()
            b.copyPixelsFromBuffer(plane.buffer)
            val shown = if (width != img.width) Bitmap.createBitmap(b, 0, 0, img.width, img.height) else b // drop the row padding
            val out = ByteArrayOutputStream(96 * 1024)
            out.write(byteArrayOf(0, 0, 0, 0))
            out.write(byteArrayOf((sid shr 24).toByte(), (sid shr 16).toByte(), (sid shr 8).toByte(), sid.toByte()))
            shown.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
            if (shown !== b) shown.recycle()
            val frame = out.toByteArray()
            // unchanged picture: only a keep-alive once a second
            var fp = frame.size
            val step = max(1, frame.size / 2048)
            var i = 8
            while (i < frame.size) { fp = fp * 31 + frame[i]; i += step }
            if (fp == lastPrint && now - lastSent < BUSY_FRAME_MS) return
            val key = Hub.keyFor(c) ?: return
            c.send(Crypto.encryptBytes(key, frame, 0, frame.size))
            lastPrint = fp
            lastSent = now
        } catch (_: Exception) {
        } finally {
            img.close()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (running) handler?.post { try { buildDisplay() } catch (_: Exception) {} } // rotation: new picture size
    }

    private fun stopSharing(notify: Boolean) {
        val was = running
        running = false
        val c = conn
        if (was && notify && c != null && c.isOpen) Hub.sendJson(c, JSONObject().put("type", "screen-stop").put("sid", sid))
        try { display?.release() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        display = null; reader = null; projection = null; bmp = null; conn = null
        thread?.quitSafely(); thread = null
        RemoteControlService.instance?.releaseAll()
        Screen.controlOn = false
        if (Screen.shareConn === c) { Screen.shareConn = null; Screen.shareSid = 0L }
        Screen.state.value = Screen.state.value.copy(sharingTo = null)
        if (was) Hub.addLog("info", "Screen sharing stopped", "")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (running) stopSharing(true)
        super.onDestroy()
    }
}
