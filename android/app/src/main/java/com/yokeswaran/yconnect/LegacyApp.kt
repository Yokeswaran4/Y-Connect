// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * This app used to be released under another name and package. Android treats that as a different app, so the old
 * copy stays on the phone after updating and keeps showing its old name and icon in the launcher.
 * This finds such a copy so the user can remove it.
 */
object LegacyApp {
    class Found(val packageName: String, val label: String)

    private fun looksOld(s: String) = s.replace(" ", "").replace("-", "").replace("_", "").contains("mikuconnect", ignoreCase = true)

    fun find(ctx: Context): List<Found> = try {
        val pm = ctx.packageManager
        pm.getInstalledApplications(0)
            .filter { it.packageName != ctx.packageName }
            .map { Found(it.packageName, pm.getApplicationLabel(it).toString()) }
            .filter { looksOld(it.label) || looksOld(it.packageName) }
    } catch (_: Exception) { emptyList() }

    /** Opens Android's own "Uninstall this app?" dialog. */
    fun uninstall(ctx: Context, packageName: String) {
        try {
            ctx.startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { toast(ctx, "Could not open the uninstall screen") }
    }
}
