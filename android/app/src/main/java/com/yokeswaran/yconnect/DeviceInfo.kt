// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.PowerManager
import android.view.Display
import androidx.core.app.NotificationManagerCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * "About this device". The About page only shows [brief] (model, Android version, app version: cheap Build fields,
 * no processes started). The long list from [collect] (CPU, skin, launcher, window modes ...) is kept for the
 * debug report, which is built on demand. Neither contains the device name, serial numbers, Android ID,
 * IP addresses or the pairing code.
 */
object DeviceInfo {
    data class Section(val title: String, val rows: List<Pair<String, String>>)

    private fun prop(key: String): String = try {
        val p = Runtime.getRuntime().exec(arrayOf("getprop", key))
        val out = p.inputStream.bufferedReader().use { it.readText() }.trim()
        p.destroy()
        out
    } catch (_: Exception) { "" }

    private fun firstProp(vararg keys: String): Pair<String, String>? {
        for (k in keys) { val v = prop(k); if (v.isNotEmpty()) return k to v }
        return null
    }

    /** The manufacturer's Android skin, when there is one (stock Android / Pixel has none). */
    private fun skin(): String {
        val oneUi = prop("ro.build.version.oneui")
        if (oneUi.toIntOrNull() != null) { val n = oneUi.toInt(); return "Samsung One UI ${n / 10000}.${n / 100 % 100}.${n % 100}" }
        firstProp("ro.mi.os.version.name")?.let { return "Xiaomi HyperOS ${it.second}" }
        firstProp("ro.miui.ui.version.name")?.let { return "Xiaomi MIUI ${it.second}" }
        firstProp("ro.build.version.oplusrom", "ro.build.version.opporom")?.let { return "OPPO / OnePlus (${it.second})" }
        firstProp("ro.build.version.emui", "ro.build.version.magic")?.let { return "Huawei / Honor (${it.second})" }
        firstProp("ro.vivo.os.version", "ro.vivo.os.name")?.let { return "vivo (${it.second})" }
        firstProp("ro.build.version.realmeui")?.let { return "realme UI ${it.second}" }
        return "Stock Android / not detected"
    }

    private fun launcher(ctx: Context): String = try {
        val pm = ctx.packageManager
        val ri = pm.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)
        val pkg = ri?.activityInfo?.packageName
        if (ri == null || pkg == null || pkg == "android") "No default launcher set"
        else "${ri.loadLabel(pm)} ($pkg)"
    } catch (_: Exception) { "Unknown" }

    private fun windowing(ctx: Context): String {
        val pm = ctx.packageManager
        val modes = mutableListOf("fullscreen", "split-screen")
        if (pm.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) modes += "picture-in-picture"
        if (pm.hasSystemFeature(PackageManager.FEATURE_FREEFORM_WINDOW_MANAGEMENT)) modes += "freeform windows"
        if (pm.hasSystemFeature("android.hardware.type.pc") ||
            (ctx.resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_DESK) modes += "desktop mode"
        return modes.joinToString(", ")
    }

    private fun cpu(): String {
        var model = ""
        if (Build.VERSION.SDK_INT >= 31) model = listOf(Build.SOC_MANUFACTURER, Build.SOC_MODEL).filter { it.isNotBlank() && it != Build.UNKNOWN }.joinToString(" ")
        if (model.isEmpty()) {
            try {
                model = File("/proc/cpuinfo").readLines().firstNotNullOfOrNull { l ->
                    if (Regex("^(Hardware|model name)\\s*:", RegexOption.IGNORE_CASE).containsMatchIn(l)) l.substringAfter(':').trim().ifEmpty { null } else null
                } ?: ""
            } catch (_: Exception) {}
        }
        if (model.isEmpty()) model = Build.HARDWARE
        return "$model · ${Runtime.getRuntime().availableProcessors()} cores · ${Build.SUPPORTED_ABIS.firstOrNull() ?: "?"}"
    }

    private fun gb(bytes: Long) = String.format(Locale.US, "%.1f GB", bytes / 1024.0 / 1024.0 / 1024.0)

    private fun cap(s: String) = s.replaceFirstChar { it.uppercase() }

    private fun model(): String {
        val m = Build.MODEL.orEmpty()
        val maker = Build.MANUFACTURER.orEmpty()
        return if (m.startsWith(maker, ignoreCase = true)) m else "${cap(maker)} $m".trim()
    }

    /** One line for the Activity log. Only reads Build fields, so it is cheap to call on the main thread. */
    fun summary(): String {
        val soc = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL.takeIf { it.isNotBlank() && it != Build.UNKNOWN } else null
        return listOfNotNull(model(), "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})", soc ?: Build.HARDWARE).joinToString(" · ")
    }

    /** The few lines the About page shows. Only reads Build fields, so it is safe to call while composing. */
    fun brief(ctx: Context): List<Pair<String, String>> {
        val ver = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName } catch (_: Exception) { null }
        return listOf(
            "Device" to model(),
            "Android" to "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "Y Connect" to (ver ?: "?"),
        )
    }

    /** Full details for the debug report. Blocking (runs getprop and reads /proc): call from a background thread. */
    fun collect(ctx: Context): List<Section> {
        val pm = ctx.packageManager
        val app = try { pm.getPackageInfo(ctx.packageName, 0) } catch (_: Exception) { null }
        val mem = try {
            ActivityManager.MemoryInfo().also { (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it) }.totalMem
        } catch (_: Exception) { 0L }
        val dm = ctx.resources.displayMetrics
        val hz = try { ctx.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate } catch (_: Exception) { null }
        val dark = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val batteryOpt = try { (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName) } catch (_: Exception) { null }
        val notifAccess = try { NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName) } catch (_: Exception) { null }

        fun rows(title: String, vararg r: Pair<String, String?>) = Section(title, r.filter { !it.second.isNullOrBlank() }.map { it.first to it.second!! })
        return listOf(
            rows("App",
                "Version" to (app?.versionName ?: "?") + (app?.let { " (code ${it.longVersionCode})" } ?: ""),
                "Target SDK" to (app?.applicationInfo?.targetSdkVersion?.toString()),
                "Notification access" to notifAccess?.let { if (it) "Granted" else "Not granted" },
                "Battery optimization" to batteryOpt?.let { if (it) "Unrestricted" else "Optimized (may stop sync in the background)" },
            ),
            rows("Hardware",
                "Model" to model(),
                "Device / product" to "${Build.DEVICE} / ${Build.PRODUCT}",
                "CPU" to cpu(),
                "Board" to Build.BOARD,
                "Memory" to (if (mem > 0) gb(mem) else null),
                "Display" to "${dm.widthPixels}×${dm.heightPixels} px · ${dm.densityDpi} dpi" + (hz?.let { String.format(Locale.US, " · %.0f Hz", it) } ?: ""),
            ),
            rows("System",
                "Android" to "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
                "Security patch" to Build.VERSION.SECURITY_PATCH,
                "Build" to Build.DISPLAY,
                "Kernel" to System.getProperty("os.version"),
                "Manufacturer skin" to skin(),
                "Home screen (launcher)" to launcher(ctx),
                "Window manager" to "Android WindowManager (system compositor)",
                "Window modes" to windowing(ctx),
                "Color mode" to (if (dark) "Dark" else "Light"),
                "Language" to Locale.getDefault().toLanguageTag(),
            ),
        )
    }

    /** Plain-text report for bug reports: the device info plus the recent activity log. */
    fun report(sections: List<Section>, log: List<LogEntry>): String {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val ip = Regex("\\b\\d{1,3}(\\.\\d{1,3}){3}\\b")
        val sb = StringBuilder("Y Connect debug report\nGenerated: ${iso.format(Date())}\n\n")
        for (s in sections) {
            sb.append("[${s.title}]\n")
            s.rows.forEach { (k, v) -> sb.append("$k: $v\n") }
            sb.append('\n')
        }
        sb.append("[Recent activity, newest first. Clipboard and notification text and IP addresses are left out]\n")
        if (log.isEmpty()) sb.append("(empty)\n")
        for (l in log) {
            val hide = l.kind == "clip" || l.kind == "notif"
            sb.append("${iso.format(Date(l.time))} ${l.kind} | ${l.title}")
            if (!hide && l.text.isNotBlank()) sb.append(" | ").append(ip.replace(l.text, "x.x.x.x"))
            if (l.count > 1) sb.append(" x${l.count}")
            sb.append('\n')
        }
        return sb.toString()
    }
}
