// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat

/**
 * Invisible activity.
 *  - Quick-settings tile / notification button: Android only lets the focused app read the
 *    clipboard, so this briefly takes focus, reads it, sends it, and closes.
 *  - Share target ("Share > Y Connect"): shared text goes to the clipboard of the other
 *    devices, shared files are sent to every connected device.
 */
class ClipboardSendActivity : Activity() {
    private var done = false
    /** Opened by [ClipboardWatcher]: send quietly (no toast) and skip text that came from another device. */
    private var auto = false

    companion object { const val EXTRA_AUTO = "auto" }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Hub.ensureStarted(this)
        try { ContextCompat.startForegroundService(this, Intent(this, SyncService::class.java)) } catch (_: Exception) {}
        auto = intent?.getBooleanExtra(EXTRA_AUTO, false) == true
        val action = intent?.action
        if (action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE) {
            val uris = sharedUris(intent)
            if (uris.isNotEmpty()) {
                sendFiles(uris)
                return
            }
            val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!shared.isNullOrEmpty()) finishWith(shared)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: ""
        finishWith(text)
    }

    private fun sharedUris(i: Intent): List<Uri> {
        val out = mutableListOf<Uri>()
        if (i.action == Intent.ACTION_SEND_MULTIPLE) {
            IntentCompat.getParcelableArrayListExtra(i, Intent.EXTRA_STREAM, Uri::class.java)?.let { out.addAll(it) }
        } else {
            IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java)?.let { out.add(it) }
        }
        return out
    }

    private fun sendFiles(uris: List<Uri>) {
        done = true
        val targets = Hub.peers.value.map { it.id }
        val msg = if (targets.isEmpty()) {
            "No connected devices"
        } else if (Transfers.sendUris(this, uris, targets) > 0) {
            "Sending ${uris.size} file${if (uris.size > 1) "s" else ""}…"
        } else {
            "Couldn't read the file"
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun finishWith(text: String) {
        if (done) return
        done = true
        if (auto) {
            // quiet mode: ignore empty text, text that arrived from another device, and text we already sent
            if (text.isNotEmpty() && text != Hub.lastRemoteClip && text != Hub.lastSentClip && Hub.settings.value.clipboardSync) Hub.sendClipboard(text)
            finish()
            overridePendingTransition(0, 0)
            return
        }
        val msg = if (text.isEmpty()) {
            "Clipboard is empty"
        } else {
            val n = Hub.sendClipboard(text)
            if (n > 0) "Sent to $n device${if (n > 1) "s" else ""}" else "No connected devices"
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        finish()
    }
}
