// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.abs

data class LatencyStats(
    val samples: List<Float?>, // newest last; null = no answer (lost)
    val times: List<Long>,     // wall-clock ms of each sample
    val answered: Boolean,     // the other device has answered at least once (older versions never do)
    val last: Float?, val avg: Float?, val min: Float?, val max: Float?, val jitter: Float?,
    val loss: Int,
)

/**
 * Connection latency to each paired device. A small encrypted "ping" goes over the same link as everything
 * else and the other side answers "pong", so the number is what clipboard, notifications and files experience.
 * Pings are sent every 2 s while the Devices page is on screen and only every 30 s otherwise, to spare the battery.
 */
object Latency {
    const val KEEP = 60
    private const val TIMEOUT_MS = 5000L
    private const val FAST_MS = 2000L
    private const val SLOW_MS = 30000L

    @Volatile var uiVisible = false          // app in the foreground
    val watchers = AtomicInteger(0)          // Devices-page latency panels currently on screen
    val stats = MutableStateFlow<Map<String, LatencyStats>>(emptyMap())

    private class Track {
        val samples = ArrayList<Float?>()
        val times = ArrayList<Long>()
        val pend = HashMap<Long, Long>() // seq -> nanoTime sent
        var seq = 0L
        var answered = false
    }
    private val tracks = HashMap<String, Track>() // guarded by `this`
    @Volatile private var started = false
    @Volatile private var lastPing = 0L

    fun start() {
        if (started) return
        started = true
        thread(isDaemon = true, name = "yconnect-latency") {
            while (true) {
                try { Thread.sleep(1000); tick() } catch (_: InterruptedException) { return@thread } catch (_: Exception) {}
            }
        }
    }

    /** Ping again on the next tick (used when the Devices page appears). */
    fun nudge() { lastPing = 0L }

    private fun tick() {
        sweep()
        val every = if (uiVisible && watchers.get() > 0) FAST_MS else SLOW_MS
        val now = System.currentTimeMillis()
        if (now - lastPing >= every - 100) {
            lastPing = now
            for (id in Hub.byId.keys.toList()) ping(id)
        }
    }

    @Synchronized
    fun ping(id: String) {
        val conn = Hub.byId[id] ?: return
        val t = tracks.getOrPut(id) { Track() }
        t.seq++
        t.pend[t.seq] = System.nanoTime()
        Hub.sendJson(conn, JSONObject().put("type", "ping").put("n", t.seq))
    }

    @Synchronized
    fun onPong(id: String, n: Long) {
        val t = tracks[id] ?: return
        val t0 = t.pend.remove(n) ?: return
        t.answered = true
        push(t, (System.nanoTime() - t0) / 1_000_000f)
        publish(id)
    }

    @Synchronized
    private fun sweep() {
        val now = System.nanoTime()
        for ((id, t) in tracks) {
            val expired = t.pend.filterValues { (now - it) / 1_000_000L > TIMEOUT_MS }.keys
            if (expired.isEmpty()) continue
            expired.forEach { t.pend.remove(it); push(t, null) }
            publish(id)
        }
    }

    private fun push(t: Track, v: Float?) {
        t.samples.add(v); t.times.add(System.currentTimeMillis())
        if (t.samples.size > KEEP) { t.samples.removeAt(0); t.times.removeAt(0) }
    }

    /** Five quick pings, for a better feel of jitter and loss. */
    fun burst(id: String) {
        thread(isDaemon = true, name = "yconnect-ping") {
            repeat(5) { try { ping(id); Thread.sleep(150) } catch (_: Exception) {} }
        }
    }

    @Synchronized fun reset(id: String) { tracks.remove(id); stats.value = stats.value - id }
    @Synchronized fun drop(id: String) { tracks.remove(id); stats.value = stats.value - id }

    private fun publish(id: String) {
        val t = tracks[id] ?: return
        val sm = t.samples.toList()
        val ok = sm.filterNotNull()
        var jit = 0f
        var pairs = 0
        for (i in 1 until sm.size) {
            val a = sm[i]; val b = sm[i - 1]
            if (a != null && b != null) { jit += abs(a - b); pairs++ }
        }
        stats.value = stats.value + (id to LatencyStats(
            samples = sm, times = t.times.toList(), answered = t.answered,
            last = sm.lastOrNull(),
            avg = if (ok.isEmpty()) null else ok.average().toFloat(),
            min = ok.minOrNull(), max = ok.maxOrNull(),
            jitter = if (pairs > 0) jit / pairs else null,
            loss = if (sm.isEmpty()) 0 else 100 * (sm.size - ok.size) / sm.size,
        ))
    }
}
