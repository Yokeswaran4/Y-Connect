// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.Notification
import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Forwards every normal notification on this phone to the connected devices. */
class YConnectNotificationListener : NotificationListenerService() {
    private val iconCache = HashMap<String, String>()

    /** The app's launcher icon as a small base64 PNG, so other devices can show the right icon. */
    private fun iconB64(pkg: String): String = iconCache.getOrPut(pkg) {
        try {
            val d = packageManager.getApplicationIcon(pkg)
            val bmp = android.graphics.Bitmap.createBitmap(96, 96, android.graphics.Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, 96, 96)
            d.draw(android.graphics.Canvas(bmp))
            val out = java.io.ByteArrayOutputStream()
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
            android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
        } catch (_: Exception) { "" }
    }

    override fun onCreate() {
        super.onCreate()
        Hub.ensureStarted(this)
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Hub.ensureStarted(this)
    }

    /** Android can unbind a listener (battery savers, updates). Ask to be bound again so forwarding keeps working. */
    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        try { requestRebind(ComponentName(this, YConnectNotificationListener::class.java)) } catch (_: Exception) {}
    }

    private fun clean(c: CharSequence?): String = c?.toString()?.trim().orEmpty()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            Hub.ensureStarted(this)
            if (sbn.packageName == packageName || sbn.isOngoing) return
            val n = sbn.notification ?: return
            if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
            val extras = n.extras
            val title = clean(extras.getCharSequence(Notification.EXTRA_TITLE_BIG))
                .ifEmpty { clean(extras.getCharSequence(Notification.EXTRA_TITLE)) }
            var text = clean(extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
                .ifEmpty { clean(extras.getCharSequence(Notification.EXTRA_TEXT)) }
            if (text.isEmpty()) { // inbox / messaging styles keep their text elsewhere
                text = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                    ?.map { clean(it) }?.filter { it.isNotEmpty() }?.joinToString("\n").orEmpty()
            }
            if (text.isEmpty()) {
                text = clean(extras.getCharSequence(Notification.EXTRA_SUB_TEXT))
                    .ifEmpty { clean(extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)) }
            }
            if (title.isBlank() && text.isBlank()) return
            val label = try {
                packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
            } catch (_: Exception) {
                sbn.packageName
            }
            Hub.sendNotification(label, title, text, iconB64(sbn.packageName))
        } catch (_: Exception) {
            // never let one odd notification stop the listener
        }
    }
}
