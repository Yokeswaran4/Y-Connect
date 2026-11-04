// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Automatic phone -> computer clipboard sync.
 *
 * Since Android 10 an app may only READ the clipboard while it has focus, but it is still TOLD when the clipboard
 * changes. So: when the clipboard changes, a 1x1 pixel overlay window is shown (this is what the
 * "Display over other apps" permission allows, and it makes Android accept a start from the background), the invisible
 * [ClipboardSendActivity] opens for a split second, reads the clipboard while it has focus, sends it and closes.
 *
 * It is optional (Settings > Sync > "Send clipboard automatically") and needs that permission. Some phone makers
 * restrict background activity starts further; if it does not work on your phone, the tile / notification button /
 * Share menu still work as before.
 */
object ClipboardWatcher {
    private val main = Handler(Looper.getMainLooper())
    private var registered = false
    private var overlay: View? = null
    @Volatile private var lastTrigger = 0L

    /** Whether "Display over other apps" is granted (the Settings page shows a button while it is not). */
    val overlayGranted = MutableStateFlow(false)

    private val listener = ClipboardManager.OnPrimaryClipChangedListener { onChanged() }

    fun canOverlay(ctx: Context): Boolean = try { Settings.canDrawOverlays(ctx) } catch (_: Exception) { false }

    /** Starts or stops listening to match the settings and the permission. Safe to call any time. */
    @Synchronized
    fun refresh(ctx: Context) {
        val s = Hub.settings.value
        overlayGranted.value = canOverlay(ctx)
        val want = s.autoClipboard && s.clipboardSync && canOverlay(ctx)
        try {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            if (want && !registered) {
                cm.addPrimaryClipChangedListener(listener)
                registered = true
            } else if (!want && registered) {
                cm.removePrimaryClipChangedListener(listener)
                registered = false
            }
        } catch (_: Exception) {}
    }

    private fun onChanged() {
        val now = System.currentTimeMillis()
        if (now < Hub.ignoreClipUntil) return          // we set it ourselves a moment ago (text from another device)
        if (Hub.peers.value.isEmpty()) return
        if (now - lastTrigger < 800) return            // one change often fires the listener twice
        lastTrigger = now
        main.post { launch() }
    }

    private fun launch() {
        val ctx = Hub.appCtx
        if (!canOverlay(ctx)) return
        try {
            val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            if (overlay == null) {
                val v = View(ctx)
                val lp = WindowManager.LayoutParams(
                    1, 1,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT
                )
                lp.gravity = Gravity.TOP or Gravity.START
                wm.addView(v, lp)
                overlay = v
            }
            ctx.startActivity(
                Intent(ctx, ClipboardSendActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                    .putExtra(ClipboardSendActivity.EXTRA_AUTO, true)
            )
        } catch (_: Exception) {
            removeOverlay()
            return
        }
        main.postDelayed({ removeOverlay() }, 2500)
    }

    private fun removeOverlay() {
        val v = overlay ?: return
        overlay = null
        try {
            (Hub.appCtx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v)
        } catch (_: Exception) {}
    }
}
