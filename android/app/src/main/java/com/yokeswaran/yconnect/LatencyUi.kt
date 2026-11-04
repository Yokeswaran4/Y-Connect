// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.util.Locale
import kotlin.math.roundToInt

private class Quality(val color: Color, val label: String)

@Composable
private fun quality(l: LatencyStats?): Quality {
    val cs = MaterialTheme.colorScheme
    if (l == null || l.samples.isEmpty()) return Quality(cs.outline, "Measuring…")
    if (!l.answered) return Quality(cs.outline, "No reply yet")
    val rec = l.samples.takeLast(5)
    val ok = rec.filterNotNull()
    if (ok.isEmpty()) return Quality(cs.error, "No reply")
    if (rec.size - ok.size >= 2) return Quality(cs.error, "Unstable")
    val avg = ok.average()
    return when {
        avg < 20 -> Quality(OkGreen, "Excellent")
        avg < 60 -> Quality(Color(0xFF8BC34A), "Good")
        avg < 150 -> Quality(Color(0xFFF0A35A), "Fair")
        else -> Quality(cs.error, "Poor")
    }
}

private fun fmtMs(v: Float?): String = when {
    v == null -> "—"
    v < 10f -> String.format(Locale.US, "%.1f ms", v)
    else -> "${v.roundToInt()} ms"
}

private fun yMax(l: LatencyStats?): Float = maxOf(40f, l?.samples?.filterNotNull()?.maxOrNull() ?: 0f) * 1.15f

/** Draws the samples right-aligned across [Latency.KEEP] slots: a line, a soft fill and a red bar for every lost ping. */
private fun DrawScope.drawLatency(l: LatencyStats?, color: Color, lost: Color, strokePx: Float) {
    val sm = l?.samples ?: emptyList()
    val max = yMax(l)
    val off = Latency.KEEP - sm.size
    val step = size.width / (Latency.KEEP - 1)
    val runs = ArrayList<List<Offset>>()
    var cur = ArrayList<Offset>()
    sm.forEachIndexed { i, v ->
        val x = (off + i) * step
        if (v == null) {
            if (cur.isNotEmpty()) { runs.add(cur); cur = ArrayList() }
            drawLine(lost.copy(alpha = 0.7f), Offset(x, 0f), Offset(x, size.height), strokeWidth = strokePx)
        } else cur.add(Offset(x, size.height - 2f - (v / max) * (size.height - 4f)))
    }
    if (cur.isNotEmpty()) runs.add(cur)
    for (r in runs) {
        if (r.size == 1) { drawCircle(color, strokePx, r[0]); continue }
        val line = Path().apply { moveTo(r[0].x, r[0].y); for (p in r.drop(1)) lineTo(p.x, p.y) }
        val area = Path().apply {
            moveTo(r[0].x, size.height); for (p in r) lineTo(p.x, p.y); lineTo(r.last().x, size.height); close()
        }
        drawPath(area, color.copy(alpha = 0.16f))
        drawPath(line, color, style = Stroke(width = strokePx, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/**
 * Latency to one connected device: tap the row to open an interactive graph (touch or drag to read a sample),
 * the average / best / worst / jitter / loss numbers and a "Ping ×5" test.
 */
@Composable
internal fun LatencyPanel(id: String, address: String? = null) {
    val cs = MaterialTheme.colorScheme
    val all by Latency.stats.collectAsState()
    val l = all[id]
    val q = quality(l)
    var open by remember(id) { mutableStateOf(false) }
    // tell the pinger that somebody is looking, so it measures every 2 s instead of every 30 s
    DisposableEffect(Unit) {
        Latency.watchers.incrementAndGet(); Latency.nudge()
        onDispose { Latency.watchers.decrementAndGet() }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { open = !open }.padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(q.color))
            Spacer(Modifier.width(8.dp))
            Text(if (l != null && l.samples.isNotEmpty() && l.last == null) "lost" else fmtMs(l?.last), fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(8.dp))
            Dim(q.label)
            Spacer(Modifier.weight(1f))
            Dim(if (open) "Hide details ▴" else "Details ▾")
        }
        if (open) {
            if (address != null) Dim("Address · $address")
            var selTime by remember(id) { mutableStateOf<Long?>(null) }
            val latest by rememberUpdatedState(l)
            val sel = selTime
            val idx = if (l != null && sel != null) l.times.indexOf(sel) else -1
            val tip = if (l != null && idx >= 0) {
                val v = l.samples[idx]
                val ago = ((System.currentTimeMillis() - l.times[idx]) / 1000).coerceAtLeast(0)
                (if (v == null) "Lost" else fmtMs(v)) + " · " + (if (ago < 2) "just now" else "$ago s ago")
            } else "Touch the graph to read a single sample"
            Dim(tip, if (idx >= 0) cs.onSurface else cs.onSurfaceVariant)
            val grid = cs.outlineVariant
            val ink = cs.onSurface
            Canvas(
                Modifier.fillMaxWidth().height(96.dp).clip(RoundedCornerShape(10.dp)).background(cs.surface)
                    .pointerInput(Unit) {
                        fun pick(x: Float) {
                            val cur = latest ?: return
                            val n = cur.samples.size
                            val i = (x / size.width * (Latency.KEEP - 1)).roundToInt() - (Latency.KEEP - n)
                            selTime = if (i in 0 until n) cur.times[i] else null
                        }
                        detectTapGestures(onTap = { pick(it.x) })
                    }
                    .pointerInput(Unit) {
                        fun pick(x: Float) {
                            val cur = latest ?: return
                            val n = cur.samples.size
                            val i = (x / size.width * (Latency.KEEP - 1)).roundToInt() - (Latency.KEEP - n)
                            selTime = if (i in 0 until n) cur.times[i] else null
                        }
                        detectHorizontalDragGestures(onDragStart = { pick(it.x) }, onHorizontalDrag = { c, _ -> pick(c.position.x) })
                    }
            ) {
                for (f in floatArrayOf(0.25f, 0.5f, 0.75f)) {
                    drawLine(grid, Offset(0f, size.height * f), Offset(size.width, size.height * f), strokeWidth = 1f,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 12f)))
                }
                drawLatency(l, q.color, cs.error, 3f)
                if (l != null && idx >= 0) {
                    val x = (Latency.KEEP - l.samples.size + idx) * (size.width / (Latency.KEEP - 1))
                    drawLine(ink.copy(alpha = 0.6f), Offset(x, 0f), Offset(x, size.height), strokeWidth = 2f)
                    l.samples[idx]?.let { v -> drawCircle(q.color, 6f, Offset(x, size.height - 2f - (v / yMax(l)) * (size.height - 4f))) }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Dim("~2 min ago")
                Dim("scale 0–${yMax(l).roundToInt()} ms")
                Dim("now")
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Stat("Now", fmtMs(l?.last), Modifier.weight(1f))
                Stat("Average", fmtMs(l?.avg), Modifier.weight(1f))
                Stat("Best", fmtMs(l?.min), Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Stat("Worst", fmtMs(l?.max), Modifier.weight(1f))
                Stat("Jitter", fmtMs(l?.jitter), Modifier.weight(1f))
                Stat("Lost", "${l?.loss ?: 0}%", Modifier.weight(1f))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { Latency.burst(id) }) { Text("Ping ×5") }
                Box(Modifier.weight(1f)) {
                    Dim(
                        if (l != null && !l.answered && l.samples.size > 2) "This device's Y Connect version doesn't answer pings yet."
                        else "Measured through the encrypted link, every 2 s while this page is open."
                    )
                }
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.clip(RoundedCornerShape(10.dp)).background(cs.surface).padding(horizontal = 10.dp, vertical = 8.dp)) {
        Dim(label)
        Text(value, fontWeight = FontWeight.SemiBold)
    }
}
