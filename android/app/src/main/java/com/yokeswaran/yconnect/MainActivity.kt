// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.util.Locale

internal val OkGreen = StatusOnline

internal fun fmtSize(b: Long): String {
    if (b < 1024) return "$b B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var v = b / 1024.0
    var i = 0
    while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
    return String.format(Locale.getDefault(), "%.1f %s", v, units[i])
}

class MainActivity : ComponentActivity() {
    private val notifAccess = mutableStateOf(false)
    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    // file picker for "Send file" under a connected device
    private var pickTarget: String? = null
    private val picker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val id = pickTarget
        if (id != null && uris.isNotEmpty()) {
            // keep read access so an interrupted transfer can be continued later
            uris.forEach { try { contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {} }
            val n = Transfers.sendUris(this, uris, listOf(id))
            Toast.makeText(
                this,
                if (n > 0) "Sending ${uris.size} file${if (uris.size > 1) "s" else ""}…" else "Couldn't read the file",
                Toast.LENGTH_SHORT
            ).show()
        }
    }

    // folder picker for "Send folder"
    private var folderTarget: String? = null
    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val id = folderTarget
        if (id != null && uri != null) {
            try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            Transfers.sendTree(this, uri, listOf(id))
            Toast.makeText(this, "Preparing folder…", Toast.LENGTH_SHORT).show()
        }
    }

    // "Share screen": Android's own consent screen first, then the service starts capturing
    private var shareTarget: String? = null
    private val projectionLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val id = shareTarget
        val data = r.data
        if (id != null && r.resultCode == RESULT_OK && data != null) ScreenShareService.start(this, r.resultCode, data, id)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        Hub.ensureStarted(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) permLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        try { ContextCompat.startForegroundService(this, Intent(this, SyncService::class.java)) } catch (_: Exception) {}
        setContent {
            val st by Hub.settings.collectAsState()
            val dark = when (st.theme) {
                "light" -> false
                "dark" -> true
                else -> isSystemInDarkTheme()
            }
            val ctx = LocalContext.current
            val scheme = when {
                st.systemColors && Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
                dark -> CatDark
                else -> CatLight
            }
            // keep status/navigation bar icons readable when the app theme differs from the system theme
            androidx.compose.runtime.DisposableEffect(dark) {
                val transparent = android.graphics.Color.TRANSPARENT
                enableEdgeToEdge(
                    statusBarStyle = if (dark) androidx.activity.SystemBarStyle.dark(transparent) else androidx.activity.SystemBarStyle.light(transparent, transparent),
                    navigationBarStyle = if (dark) androidx.activity.SystemBarStyle.dark(transparent) else androidx.activity.SystemBarStyle.light(transparent, transparent),
                )
                onDispose {}
            }
            MaterialTheme(colorScheme = scheme, shapes = CatShapes, typography = catTypography()) {
                YConnectApp(
                    notifAccess.value,
                    onSendFiles = { id ->
                        pickTarget = id
                        picker.launch(arrayOf("*/*"))
                    },
                    onSendFolder = { id ->
                        folderTarget = id
                        folderPicker.launch(null)
                    },
                    onShareScreen = { id ->
                        if (Screen.state.value.sharingTo != null) ScreenShareService.stop(this)
                        else {
                            shareTarget = id
                            projectionLauncher.launch((getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager).createScreenCaptureIntent())
                        }
                    },
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        Latency.uiVisible = true
        Updates.autoCheck(this) // only does anything when "Notify me about new releases" is on
    }

    override fun onStop() {
        Latency.uiVisible = false
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        notifAccess.value = NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)
        ClipboardWatcher.refresh(this) // picks up "Display over other apps" granted in system settings
    }
}
