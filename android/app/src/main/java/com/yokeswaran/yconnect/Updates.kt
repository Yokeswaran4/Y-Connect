// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Looks for a newer Y Connect release on GitHub. This is the only place the app talks to the internet,
 * so it is manual by default: "Check for updates" in About, plus an opt-in switch that checks about once
 * a day and posts a notification when a new version is out. Nothing about you or your devices is sent
 * (it is one plain GET of the public "latest release" page).
 */
object Updates {
    private const val API = "https://api.github.com/repos/Yokeswaran4/Y-Connect/releases/latest"
    private const val FALLBACK_PAGE = "https://github.com/Yokeswaran4/Y-Connect/releases"
    private const val CHANNEL = "updates"
    private const val EVERY_MS = 24L * 3600_000L

    sealed class Result {
        data class Newer(val tag: String, val url: String, val notes: String) : Result()
        data class UpToDate(val tag: String) : Result()
        data class Failed(val why: String) : Result()
    }

    /** The newest release we know of when it is newer than this app (drives the badge on the About tab). */
    val available = MutableStateFlow<Result.Newer?>(null)

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("yconnect", Context.MODE_PRIVATE)

    fun autoEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean("upd_auto", false)
    fun setAuto(ctx: Context, on: Boolean) { prefs(ctx).edit().putBoolean("upd_auto", on).apply() }
    fun lastChecked(ctx: Context): Long = prefs(ctx).getLong("upd_last", 0L)

    fun currentVersion(ctx: Context): String =
        try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "v2.0" } catch (_: Exception) { "v2.0" }

    /** "v1.2.0-beta" -> [1, 2, 0]. Anything that is not a number is ignored. */
    internal fun parts(v: String): List<Int> =
        v.trim().removePrefix("v").removePrefix("V").substringBefore('-').substringBefore('+')
            .split('.').map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }

    internal fun isNewer(latest: String, current: String): Boolean {
        val a = parts(latest); val b = parts(current)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** Blocking network call: run it on a background thread. */
    fun fetch(ctx: Context): Result {
        val current = currentVersion(ctx)
        var c: HttpURLConnection? = null
        return try {
            c = (URL(API).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000; readTimeout = 8000
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "Y-Connect-Android/$current")
            }
            when (val code = c.responseCode) {
                200 -> {
                    val o = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
                    val tag = o.optString("tag_name").ifEmpty { o.optString("name") }
                    if (tag.isEmpty()) return Result.Failed("The release has no version number.")
                    prefs(ctx).edit().putLong("upd_last", System.currentTimeMillis()).apply()
                    if (isNewer(tag, current)) {
                        val url = o.optString("html_url").takeIf { it.startsWith("https://github.com/") } ?: FALLBACK_PAGE
                        Result.Newer(tag, url, o.optString("body").trim()).also { available.value = it }
                    } else { available.value = null; Result.UpToDate(tag) }
                }
                404 -> { prefs(ctx).edit().putLong("upd_last", System.currentTimeMillis()).apply(); available.value = null; Result.UpToDate(current) }
                403, 429 -> Result.Failed("GitHub is limiting requests right now. Try again later.")
                else -> Result.Failed("GitHub answered with error $code.")
            }
        } catch (e: java.io.IOException) {
            Result.Failed("Couldn't reach GitHub. Check your internet connection.")
        } catch (e: Exception) {
            Result.Failed("Couldn't read the answer from GitHub.")
        } finally { c?.disconnect() }
    }

    fun openRelease(ctx: Context, url: String) {
        try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (_: Exception) { toast(ctx, "No app can open this link") }
    }

    /** Called when the app opens: if the switch is on and the last check is over a day old, check in the background. */
    fun autoCheck(ctx: Context) {
        val app = ctx.applicationContext
        if (!autoEnabled(app) || System.currentTimeMillis() - lastChecked(app) < EVERY_MS) return
        thread(isDaemon = true, name = "yconnect-update") {
            val r = fetch(app)
            if (r is Result.Newer) notifyOnce(app, r)
        }
    }

    /** One notification per version, so the same release never nags twice. */
    fun notifyOnce(ctx: Context, r: Result.Newer) {
        val p = prefs(ctx)
        if (p.getString("upd_notified", "") == r.tag) return
        try {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
            val open = PendingIntent.getActivity(
                ctx, 7, Intent(Intent.ACTION_VIEW, Uri.parse(r.url)), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            val n = NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Y Connect ${r.tag} is available")
                .setContentText("Tap to see what's new and download it.")
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            nm.notify(4242, n)
            p.edit().putString("upd_notified", r.tag).apply()
        } catch (_: SecurityException) { /* notification permission not granted: the About page still shows it */ }
    }
}
