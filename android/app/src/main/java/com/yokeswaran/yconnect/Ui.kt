// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import android.widget.Toast
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.key
import androidx.compose.ui.graphics.graphicsLayer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.draw.drawWithCache
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val DISCORD_URL = "https://discord.com/users/895560596064464956"
private const val REDDIT_URL = "https://www.reddit.com/user/yokeswaran_n"

private val WarnAmber = Color(0xFFF5B13C)

// ---------- icons (24x24 stroke icons, tinted at the call site) ----------
private fun icon(name: String, strokes: List<String>, fills: List<String> = emptyList()): ImageVector {
    val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    strokes.forEach {
        b.addPath(
            PathParser().parsePathString(it).toNodes(), stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.8f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round
        )
    }
    fills.forEach { b.addPath(PathParser().parsePathString(it).toNodes(), fill = SolidColor(Color.Black)) }
    return b.build()
}

private val DiscordIcon by lazy {
    icon(
        "discord",
        listOf("M5.5 6.2C7.3 5 9.2 4.5 9.2 4.5l.6 1.2a12 12 0 0 1 4.4 0l.6-1.2s1.9.5 3.7 1.7C20.2 9 21 12.2 20.8 16c-1.5 1.2-3 1.8-4.4 2.2l-1-1.6c.5-.2 1-.4 1.4-.7a9 9 0 0 1-9.6 0c.4.3.9.5 1.4.7l-1 1.6C5.8 17.8 4.3 17.2 2.8 16 2.6 12.2 3.5 9 5.5 6.2z"),
        listOf("M9 10.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z", "M15 10.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z")
    )
}
private val RedditIcon by lazy {
    icon(
        "reddit",
        listOf("M12 8.5c-4 0-7 2.2-7 5s3 5 7 5 7-2.2 7-5-3-5-7-5z", "M12 8.5l1-4.5 3.5.8", "M9.3 16c1.5 1 4 1 5.4 0"),
        listOf(
            "M9.2 11.9a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2z", "M14.8 11.9a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2z",
            "M4.6 10a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8z", "M19.4 10a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8z",
            "M17.3 3.9a1 1 0 1 0 0 2a1 1 0 1 0 0-2z"
        )
    )
}
private val PhoneIcon by lazy { icon("phone", listOf("M9.3 2.5h5.4a2.8 2.8 0 0 1 2.8 2.8v13.4a2.8 2.8 0 0 1-2.8 2.8H9.3a2.8 2.8 0 0 1-2.8-2.8V5.3a2.8 2.8 0 0 1 2.8-2.8z", "M10.5 18.5h3")) }
private val LaptopIcon by lazy { icon("laptop", listOf("M6.3 5h11.4a1.8 1.8 0 0 1 1.8 1.8v6.4a1.8 1.8 0 0 1-1.8 1.8H6.3a1.8 1.8 0 0 1-1.8-1.8V6.8A1.8 1.8 0 0 1 6.3 5z", "M2.5 19h19")) }
private val MonitorIcon by lazy { icon("monitor", listOf("M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M9 20h6M12 16v4")) }
private val DevicesIcon by lazy { icon("devices", listOf("M4.5 4h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M6 18h7M9.5 14v4", "M16.8 9h2.9a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8h-2.9a1.8 1.8 0 0 1-1.8-1.8v-7.4A1.8 1.8 0 0 1 16.8 9z")) }
private val TerminalIcon by lazy { icon("terminal", listOf("M5.5 4.5h13A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17V7a2.5 2.5 0 0 1 2.5-2.5z", "M7.5 10l3 2.5-3 2.5", "M13 15h4")) }
private val PulseIcon by lazy { icon("pulse", listOf("M3 12h4l3-8 4 16 3-8h4")) }
private val BatteryIcon by lazy { icon("battery", listOf("M4.7 7.5h11.6a2.2 2.2 0 0 1 2.2 2.2v4.6a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2V9.7a2.2 2.2 0 0 1 2.2-2.2z", "M21.5 10.5v3")) }
private val BoltIcon by lazy { icon("bolt", listOf("M13 2L4.5 13.5H11L10 22l8.5-11.5H12z")) }
private val FolderIcon by lazy { icon("folder", listOf("M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z")) }
private val DownloadIcon by lazy { icon("download", listOf("M12 4v11m0 0l-4-4m4 4l4-4M5 20h14")) }
private val UnlinkIcon by lazy { icon("unlink", listOf("M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L12 6.4M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1M4 4l16 16")) }
private val CopyIcon by lazy { icon("copy", listOf("M10.7 8.5h6.1a2.2 2.2 0 0 1 2.2 2.2v6.1a2.2 2.2 0 0 1-2.2 2.2h-6.1a2.2 2.2 0 0 1-2.2-2.2v-6.1a2.2 2.2 0 0 1 2.2-2.2z", "M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3")) }
private val ClipboardIcon by lazy { icon("clipboard", listOf("M7.2 4.5h9.6a2.2 2.2 0 0 1 2.2 2.2v12.1a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 18.8V6.7a2.2 2.2 0 0 1 2.2-2.2z", "M9 4.5V4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v.5M8.5 11h7M8.5 15h5")) }
private val BellIcon by lazy { icon("bell", listOf("M6 17.5V11a6 6 0 0 1 12 0v6.5l1.5 1.5h-15z", "M10 21.5h4")) }
private val KeyIcon by lazy { icon("key", listOf("M12 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0z", "M11 12l8-8M16 7l2.5 2.5M14 9l2 2")) }

private fun platformLabel(p: String): String = when (p.lowercase()) {
    "android" -> "Android"
    "windows" -> "Windows"
    "linux" -> "Linux"
    else -> p.replaceFirstChar { it.uppercase() }
}
private fun platformIcon(p: String): ImageVector = when (p.lowercase()) {
    "android" -> PhoneIcon
    "windows" -> MonitorIcon
    else -> LaptopIcon
}

// ---------- building blocks ----------
/**
 * Composes [content] a few frames after the screen first shows. The first frame then only has to build what is
 * visible, which keeps the tab switch and the app start smooth on slower phones. Use it for cards below the fold.
 */
@Composable
private fun Deferred(frames: Int = 1, content: @Composable () -> Unit) {
    var ready by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { repeat(frames) { withFrameNanos { } }; ready = true }
    if (ready) content()
}


/**
 * Fades a card in while it rises a few dp, once, when it first appears. It only changes how the card is drawn
 * (no re-layout, no re-composition per frame), so it stays smooth on slow phones. [delayMs] staggers a list.
 */
@Composable
private fun Appear(delayMs: Int = 0, content: @Composable () -> Unit) {
    val a = remember { Animatable(0f) }
    LaunchedEffect(Unit) { if (delayMs > 0) delay(delayMs.toLong()); a.animateTo(1f, tween(320, easing = FastOutSlowInEasing)) }
    Box(Modifier.graphicsLayer { alpha = a.value; translationY = (1f - a.value) * 24.dp.toPx() }) { content() }
}

/** Quick, flat press feedback (no spring, no overshoot) for anything tappable. */
@Composable
private fun Modifier.pressScale(src: MutableInteractionSource, to: Float = 0.97f): Modifier {
    val pressed by src.collectIsPressedAsState()
    val sc by animateFloatAsState(if (pressed) to else 1f, tween(90), label = "press")
    return this.graphicsLayer { scaleX = sc; scaleY = sc }
}

@Composable
private fun Modifier.bounceClick(shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(14.dp), onClick: () -> Unit): Modifier {
    val src = remember { MutableInteractionSource() }
    return this.pressScale(src, 0.97f).clip(shape).clickable(interactionSource = src, indication = LocalIndication.current, onClick = onClick)
}

/** Number of running transfers. Only re-composes when that number changes, not on every progress tick. */
@Composable
private fun liveTransferCount(): Int {
    val f = remember { Transfers.transfers.map { l -> l.count { it.status == "waiting" || it.status == "active" } }.distinctUntilChanged() }
    return f.collectAsState(0).value
}

@Composable
internal fun Card(title: String? = null, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(cs.surfaceContainer.copy(alpha = 0.78f))
            .border(1.dp, cs.outlineVariant, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        if (title != null) Text(title.uppercase(), color = cs.primary, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.3.sp)
        content()
    }
}

@Composable
internal fun Dim(text: String, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) = Text(text, color = color, fontSize = 12.sp)

@Composable
internal fun Page(title: String, subtitle: String, pad: PaddingValues, content: @Composable () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxSize().padding(pad).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Column(Modifier.padding(top = 4.dp, bottom = 2.dp)) {
            Text(title, fontSize = 28.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp, color = cs.onBackground)
            Dim(subtitle)
        }
        content()
        Spacer(Modifier.size(12.dp))
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text.uppercase(), color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
}

@Composable
private fun IconBubble(ic: ImageVector, tint: Color, size: Dp = 40.dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.3f)).background(tint.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
        Icon(ic, null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

@Composable
internal fun ToggleRow(label: String, hint: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(label)
            if (hint != null) Dim(hint)
        }
        Switch(checked, onChange)
    }
}

/** Toggle row with a leading icon. */
@Composable
private fun SettingRow(ic: ImageVector, label: String, hint: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconBubble(ic, cs.primary)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(label, fontWeight = FontWeight.SemiBold)
            if (hint != null) Dim(hint)
        }
        Switch(checked, { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onChange(it) })
    }
}

@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cs.outlineVariant.copy(alpha = 0.45f)).padding(3.dp)) {
        options.forEach { (value, label) ->
            val on = value == selected
            val bg by animateColorAsState(if (on) cs.primary else Color.Transparent, tween(250), label = "seg-bg")
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(13.dp)).background(bg)
                    .clickable { if (!on) { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onSelect(value) } }
                    .padding(vertical = 9.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(label, color = if (on) cs.onPrimary else cs.onSurfaceVariant, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
        }
    }
}

@Composable
private fun Pill(text: String, color: Color) {
    Text(
        text, color = color, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(color.copy(alpha = 0.15f)).padding(horizontal = 10.dp, vertical = 3.dp)
    )
}

@Composable
private fun PlatformAvatar(platform: String, online: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.size(48.dp)) {
        Box(
            Modifier.fillMaxSize().clip(RoundedCornerShape(15.dp))
                .background(Brush.linearGradient(listOf(cs.primary.copy(alpha = 0.30f), cs.tertiary.copy(alpha = 0.20f)))),
            contentAlignment = Alignment.Center
        ) { Icon(platformIcon(platform), null, tint = cs.primary, modifier = Modifier.size(24.dp)) }
        if (online) Box(Modifier.align(Alignment.BottomEnd).size(14.dp).clip(CircleShape).background(cs.surfaceContainer).padding(2.5.dp).clip(CircleShape).background(OkGreen))
    }
}

@Composable
private fun BatteryChip(level: Int, charging: Boolean) {
    val cs = MaterialTheme.colorScheme
    val c = if (charging || level > 35) OkGreen else if (level > 15) WarnAmber else cs.error
    Row(
        Modifier.clip(RoundedCornerShape(20.dp)).background(c.copy(alpha = 0.15f)).padding(horizontal = 9.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(if (charging) BoltIcon else BatteryIcon, null, tint = c, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(4.dp))
        Text("$level%", color = c, fontSize = 12.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun StatTile(ic: ImageVector, value: Int, label: String, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier.clip(shape).background(cs.surfaceContainer.copy(alpha = 0.78f)).border(1.dp, cs.outlineVariant, shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        IconBubble(ic, cs.primary, 34.dp)
        AnimatedContent(
            targetState = value,
            transitionSpec = {
                val up = targetState > initialState
                (slideInVertically(tween(220)) { if (up) it else -it } + fadeIn(tween(220)))
                    .togetherWith(slideOutVertically(tween(160)) { if (up) -it else it } + fadeOut(tween(120)))
            },
            label = "stat"
        ) { v -> Text(v.toString(), fontSize = 26.sp, fontWeight = FontWeight.Bold) }
        Dim(label)
    }
}

@Composable
private fun PulseDot(active: Boolean) {
    val t = rememberInfiniteTransition(label = "pulse")
    val a by t.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "a")
    Spacer(
        Modifier.size(10.dp).graphicsLayer { alpha = if (active) a else 1f }.clip(CircleShape)
            .background(if (active) OkGreen else MaterialTheme.colorScheme.outline)
    )
}

/** Expanding rings: "scanning for devices". */
@Composable
private fun Radar(size: Dp = 96.dp) {
    val color = MaterialTheme.colorScheme.primary
    val t = rememberInfiniteTransition(label = "radar")
    val phase = t.animateFloat(0f, 1f, infiniteRepeatable(tween(2400)), label = "p")
    Canvas(Modifier.size(size)) {
        val p = phase.value // read here (draw phase) so the composable itself is not recomposed 60 times a second
        val maxR = this.size.minDimension / 2f
        for (k in 0..1) {
            val q = (p + k * 0.5f) % 1f
            drawCircle(color.copy(alpha = (1f - q) * 0.55f), radius = maxR * q, style = Stroke(width = 3f))
        }
        drawCircle(color, radius = maxR * 0.14f)
    }
}

@Composable
private fun EmptyState(ic: ImageVector, title: String, text: String) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        IconBubble(ic, cs.onSurfaceVariant, 56.dp)
        Spacer(Modifier.height(4.dp))
        Text(title, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Text(text, color = cs.onSurfaceVariant, fontSize = 13.sp, textAlign = TextAlign.Center)
    }
}

internal fun copyText(ctx: Context, text: String) {
    try {
        (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Y Connect", text))
        toast(ctx, "Copied")
    } catch (_: Exception) { toast(ctx, "Could not copy") }
}
internal fun toast(ctx: Context, m: String) = Toast.makeText(ctx, m, Toast.LENGTH_SHORT).show()
private fun openLink(ctx: Context, url: String) {
    try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    catch (_: Exception) { toast(ctx, "No app can open this link") }
}

private fun sendClipboardNow(ctx: Context) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val t = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString() ?: ""
    toast(ctx, if (t.isEmpty()) "Clipboard is empty" else {
        val n = Hub.sendClipboard(t)
        if (n > 0) "Sent to $n device${if (n > 1) "s" else ""}" else "No connected devices"
    })
}

/** Uses a pairing code typed by the user. Returns true when it was accepted. */
private fun usePairingCode(ctx: Context, code: String): Boolean {
    val c = code.trim()
    if (Crypto.normalize(c).length < 4) { toast(ctx, "Enter the full pairing code"); return false }
    Hub.updateSettings(Hub.settings.value.copy(passphrase = c))
    toast(ctx, "Pairing code set — connecting…")
    return true
}

@Composable
private fun EnterCodeDialog(title: String, hint: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = RoundedCornerShape(28.dp),
        icon = { IconBubble(KeyIcon, cs.primary, 52.dp) },
        title = { Text(title, textAlign = TextAlign.Center) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(hint)
                OutlinedTextField(
                    code, { code = it.uppercase() }, singleLine = true, placeholder = { Text("K7QM-2XPD", modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center) },
                    shape = RoundedCornerShape(16.dp),
                    textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 22.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp, textAlign = TextAlign.Center),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { onConfirm(code) }),
                    modifier = Modifier.fillMaxWidth()
                )
                Dim("This replaces this device's pairing code.")
            }
        },
        confirmButton = { Button(onClick = { onConfirm(code) }, shape = RoundedCornerShape(14.dp)) { Text("Pair") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

// ---------- desktop-style chrome ----------
/** Top brand row, like the desktop sidebar header: logo, gradient name and a live connection LED. */
@Composable
private fun BrandBar(connected: Int) {
    val cs = MaterialTheme.colorScheme
    val intro = remember { Animatable(0f) }
    LaunchedEffect(Unit) { intro.animateTo(1f, spring(dampingRatio = 0.55f, stiffness = Spring.StiffnessLow)) }
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Image(
            painterResource(R.drawable.logo), null,
            Modifier.size(36.dp).graphicsLayer {
                val v = intro.value
                val sc = 0.55f + 0.45f * v
                scaleX = sc; scaleY = sc; alpha = v.coerceIn(0f, 1f); rotationZ = (1f - v) * -80f
            }.clip(RoundedCornerShape(11.dp)),
            contentScale = ContentScale.Fit
        )
        Spacer(Modifier.width(10.dp))
        Text(
            "Y Connect",
            style = TextStyle(brush = Brush.horizontalGradient(listOf(cs.primary, cs.tertiary)), fontSize = 18.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.2.sp)
        )
        Spacer(Modifier.weight(1f))
        val shape = RoundedCornerShape(20.dp)
        Row(
            Modifier.clip(shape).background(cs.surfaceContainer.copy(alpha = 0.78f)).border(1.dp, cs.outlineVariant, shape).animateContentSize().padding(horizontal = 11.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            PulseDot(connected > 0)
            Spacer(Modifier.width(7.dp))
            Text(if (connected > 0) "$connected connected" else "Searching", fontSize = 12.sp, color = cs.onSurfaceVariant)
        }
    }
}

/** Bottom navigation styled like the desktop tab rail: tinted pill, accent border and a glowing marker. */
@Composable
private fun RailBar(items: List<Triple<String, ImageVector, Int>>, selected: Int, onSelect: (Int) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    val barShape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val pillShape = RoundedCornerShape(14.dp)
    Row(
        Modifier.fillMaxWidth().clip(barShape).background(cs.surfaceContainer.copy(alpha = 0.94f))
            .border(1.dp, cs.outlineVariant, barShape).navigationBarsPadding().padding(horizontal = 8.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        items.forEachIndexed { i, (label, ic, count) ->
            val on = i == selected
            val tint by animateColorAsState(if (on) cs.primary else cs.onSurfaceVariant, tween(150), label = "rail-tint")
            val bar by animateFloatAsState(if (on) 1f else 0f, tween(180), label = "rail-bar")
            val pop by animateFloatAsState(if (on) 1.14f else 1f, spring(dampingRatio = 0.45f, stiffness = 500f), label = "rail-pop")
            Column(
                Modifier.weight(1f).clip(pillShape)
                    .background(Brush.verticalGradient(listOf(cs.primary.copy(alpha = 0.22f * bar), cs.primary.copy(alpha = 0.05f * bar))))
                    .border(1.dp, cs.primary.copy(alpha = 0.30f * bar), pillShape)
                    .clickable { if (!on) { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onSelect(i) } }
                    .padding(top = 4.dp, bottom = 7.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Box(Modifier.width(18.dp).height(3.dp).clip(CircleShape).background(cs.primary.copy(alpha = bar)))
                Spacer(Modifier.height(5.dp))
                BadgedBox(
                    badge = { if (count > 0) Badge { Text(count.toString()) } }
                ) { Icon(ic, label, tint = tint, modifier = Modifier.size(22.dp).graphicsLayer { scaleX = pop; scaleY = pop }) }
                Spacer(Modifier.height(3.dp))
                Text(label, fontSize = 10.5.sp, maxLines = 1, color = tint, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium)
            }
        }
    }
}

// ---------- app shell ----------
@Composable
fun YConnectApp(notifAccess: Boolean, onSendFiles: (String) -> Unit, onSendFolder: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val peers by Hub.peers.collectAsState()
    val ctx = LocalContext.current
    val pairReq by Hub.pairRequest.collectAsState()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val live = liveTransferCount()
    val update by Updates.available.collectAsState()
    val items = listOf(
        Triple("Devices", DevicesIcon, peers.size),
        Triple("Files", Icons.AutoMirrored.Filled.Send, live),
        Triple("Run", TerminalIcon, 0),
        Triple("Activity", PulseIcon, 0),
        Triple("Settings", Icons.Default.Settings, 0),
        Triple("About", Icons.Default.Info, if (update != null) 1 else 0),
    )
    // another device tapped this one in its Nearby list: ask for the code it is showing
    pairReq?.let { r ->
        EnterCodeDialog(
            title = "${r.name} wants to pair",
            hint = "Enter the pairing code shown on ${r.name}.",
            onDismiss = { Hub.dismissPairRequest() },
            onConfirm = { if (usePairingCode(ctx, it)) Hub.dismissPairRequest() }
        )
    }
    val glowA = cs.primary
    val glowB = cs.tertiary
    Surface(Modifier.fillMaxSize(), color = cs.background, contentColor = cs.onBackground) {
        Box(
            Modifier.fillMaxSize().drawWithCache {
                // soft aurora glow in the corners; the three gradients are built once per size / theme, not on every draw
                val g1 = Brush.radialGradient(listOf(glowA.copy(alpha = 0.22f), Color.Transparent), center = Offset(0f, 0f), radius = size.width * 0.95f)
                val g2 = Brush.radialGradient(listOf(glowB.copy(alpha = 0.18f), Color.Transparent), center = Offset(size.width, size.height), radius = size.width * 0.95f)
                val g3 = Brush.radialGradient(listOf(Color(0xFF22D3EE).copy(alpha = 0.10f), Color.Transparent), center = Offset(size.width * 0.75f, 0f), radius = size.width * 0.7f)
                onDrawBehind { drawRect(g1); drawRect(g2); drawRect(g3) }
            }
        ) {
            Scaffold(
                containerColor = Color.Transparent,
                contentColor = cs.onBackground,
                topBar = { BrandBar(peers.size) },
                bottomBar = { RailBar(items, tab) { tab = it } }
            ) { pad ->
                val haptic = LocalHapticFeedback.current
                val drag = remember { floatArrayOf(0f) }
                // swipe left / right anywhere to move to the next / previous tab
                Box(
                    Modifier.fillMaxSize().pointerInput(tab) {
                        detectHorizontalDragGestures(
                            onDragStart = { drag[0] = 0f },
                            onDragEnd = {
                                val next = if (drag[0] < -140f) tab + 1 else if (drag[0] > 140f) tab - 1 else tab
                                drag[0] = 0f
                                if (next != tab && next in items.indices) {
                                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    tab = next
                                }
                            },
                            onDragCancel = { drag[0] = 0f },
                            onHorizontalDrag = { _, amount -> drag[0] += amount }
                        )
                    }
                ) {
                    AnimatedContent(
                        targetState = tab,
                        transitionSpec = {
                            // the new page slides in a little from the side you are moving towards while it fades in; the old one
                            // slides out the other way. Only graphics layers move (no size animation), so it stays smooth.
                            val dir = if (targetState > initialState) 1 else -1
                            (slideInHorizontally(tween(260, easing = FastOutSlowInEasing)) { (it * 0.12f).toInt() * dir } + fadeIn(tween(220, delayMillis = 50)))
                                .togetherWith(slideOutHorizontally(tween(180, easing = FastOutSlowInEasing)) { -(it * 0.06f).toInt() * dir } + fadeOut(tween(110)))
                                .using(null)
                        },
                        label = "tabs"
                    ) { t ->
                        when (t) {
                            0 -> DevicesPage(pad, onSendFiles, onSendFolder)
                            1 -> FilesPage(pad)
                            2 -> RunPage(pad)
                            3 -> ActivityPage(pad)
                            4 -> SettingsPage(pad, notifAccess)
                            else -> AboutPage(pad)
                        }
                    }
                }
            }
        }
    }
}

// ---------- pages ----------
@Composable
private fun DevicesPage(pad: PaddingValues, onSendFiles: (String) -> Unit, onSendFolder: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val peers by Hub.peers.collectAsState()
    val ips by Hub.localIps.collectAsState()
    val nearby by Hub.nearby.collectAsState()
    val settings by Hub.settings.collectAsState()
    val ctx = LocalContext.current
    var ip by remember { mutableStateOf("") }
    var pairing by remember { mutableStateOf<Nearby?>(null) }
    var enterManual by remember { mutableStateOf(false) }
    var unpairTarget by remember { mutableStateOf<Peer?>(null) }
    // close the code dialog as soon as the other device has connected
    LaunchedEffect(peers, pairing) {
        val p = pairing
        if (p != null && peers.any { it.id == p.id }) { toast(ctx, "Paired with ${p.name}"); pairing = null }
    }
    val startPair = { n: Nearby ->
        if (Hub.sendPairRequest(n.id) != null) pairing = n else toast(ctx, "That device is no longer visible")
    }
    val live = liveTransferCount()
    var oldApps by remember { mutableStateOf(emptyList<LegacyApp.Found>()) }
    LaunchedEffect(Unit) { oldApps = withContext(Dispatchers.IO) { LegacyApp.find(ctx) } }
    Page("Devices", if (ips.isEmpty()) "No Wi-Fi connection detected" else "This phone: " + ips.joinToString(", "), pad) {
        oldApps.forEach { old -> key(old.packageName) { Appear {
            Card("Old app still installed") {
                Text("\"${old.label}\" is the previous version of this app. It is a separate app, so it keeps its old name and icon in your launcher.")
                Button(onClick = { LegacyApp.uninstall(ctx, old.packageName) }, shape = RoundedCornerShape(14.dp)) { Text("Uninstall ${old.label}") }
                Dim("Pair your devices again in Y Connect afterwards if they do not reconnect.")
            }
        } } }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile(DevicesIcon, peers.size, "Connected", Modifier.weight(1f))
            StatTile(Icons.AutoMirrored.Filled.Send, live, "Transferring", Modifier.weight(1f))
            StatTile(PulseIcon, nearby.size, "Nearby", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val clipSrc = remember { MutableInteractionSource() }
            val ipSrc = remember { MutableInteractionSource() }
            FilledTonalButton(onClick = { sendClipboardNow(ctx) }, interactionSource = clipSrc, modifier = Modifier.weight(1f).pressScale(clipSrc), shape = RoundedCornerShape(16.dp)) {
                Icon(ClipboardIcon, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Send clipboard", maxLines = 1)
            }
            FilledTonalButton(
                onClick = { if (ips.isNotEmpty()) copyText(ctx, ips.first()) else toast(ctx, "No Wi-Fi connection detected") },
                interactionSource = ipSrc, modifier = Modifier.weight(1f).pressScale(ipSrc), shape = RoundedCornerShape(16.dp)
            ) {
                Icon(CopyIcon, null, Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Copy my IP", maxLines = 1)
            }
        }

        SectionLabel("Connected")
        if (peers.isEmpty()) Card {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Radar(104.dp)
                Text("Looking for devices…", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text(
                    "Open Y Connect on your other device on the same Wi-Fi. It will appear under Nearby devices.",
                    color = cs.onSurfaceVariant, fontSize = 13.sp, textAlign = TextAlign.Center
                )
                Dim("Tip: swipe left or right to switch between tabs.")
            }
        }
        peers.forEachIndexed { i, p -> key(p.id) { Appear(i * 60) {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PlatformAvatar(p.platform, online = true)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(p.name, fontWeight = FontWeight.Bold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Dim(platformLabel(p.platform))
                    }
                    if (settings.batterySync && p.battery >= 0) BatteryChip(p.battery, p.charging)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    val fileSrc = remember { MutableInteractionSource() }
                    val folderSrc = remember { MutableInteractionSource() }
                    Button(onClick = { onSendFiles(p.id) }, interactionSource = fileSrc, modifier = Modifier.weight(1f).pressScale(fileSrc), shape = RoundedCornerShape(14.dp)) {
                        Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(17.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("File", maxLines = 1)
                    }
                    OutlinedButton(onClick = { onSendFolder(p.id) }, interactionSource = folderSrc, modifier = Modifier.weight(1f).pressScale(folderSrc), shape = RoundedCornerShape(14.dp)) {
                        Icon(FolderIcon, null, Modifier.size(17.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Folder", maxLines = 1)
                    }
                    IconButton(onClick = { unpairTarget = p }) { Icon(UnlinkIcon, "Unpair ${p.name}", tint = cs.error) }
                }
                LatencyPanel(p.id, p.address)
            }
        } } }

        SectionLabel("Nearby devices")
        Card {
            Dim("Y Connect is open on these devices. Tap one to get a pairing code, then enter that code on the other device.")
            if (nearby.isEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                Radar(44.dp)
                Spacer(Modifier.width(10.dp))
                Dim("Scanning your network…")
            }
            nearby.forEachIndexed { i, n -> key(n.id) { Appear(i * 50) {
                Row(
                    Modifier.fillMaxWidth().bounceClick { startPair(n) }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    PlatformAvatar(n.platform)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(n.name, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Dim(platformLabel(n.platform))
                    }
                    Button(onClick = { startPair(n) }, shape = RoundedCornerShape(14.dp)) { Text("Pair") }
                }
            } } }
            OutlinedButton(onClick = { enterManual = true }, shape = RoundedCornerShape(14.dp)) {
                Icon(KeyIcon, null, Modifier.size(17.dp))
                Spacer(Modifier.width(8.dp))
                Text("I have a code")
            }
        }

        Deferred(2) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                SectionLabel("Connect by IP")
                Card {
                    Dim("Use this if a device doesn't show up on its own (guest Wi-Fi, router isolation).")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            ip, { ip = it }, placeholder = { Text("192.168.1.23") }, singleLine = true,
                            shape = RoundedCornerShape(14.dp), modifier = Modifier.weight(1f)
                        )
                        Button(onClick = { if (ip.isNotBlank()) { Hub.connectTo(ip.trim()); ip = "" } }, shape = RoundedCornerShape(14.dp)) { Text("Connect") }
                    }
                }
            }
        }
    }
    unpairTarget?.let { p ->
        AlertDialog(
            onDismissRequest = { unpairTarget = null },
            shape = RoundedCornerShape(28.dp),
            icon = { IconBubble(UnlinkIcon, cs.error, 52.dp) },
            title = { Text("Unpair ${p.name}?") },
            text = { Text("This device will disconnect and won't reconnect on its own. To pair again, tap it under Nearby devices.") },
            confirmButton = { Button(onClick = { Hub.unpair(p.id); unpairTarget = null; toast(ctx, "Unpaired ${p.name}") }, shape = RoundedCornerShape(14.dp)) { Text("Unpair") } },
            dismissButton = { TextButton(onClick = { unpairTarget = null }) { Text("Cancel") } }
        )
    }
    pairing?.let { n ->
        val cancel = { Hub.cancelPairRequest(n.id); pairing = null }
        AlertDialog(
            onDismissRequest = cancel,
            shape = RoundedCornerShape(28.dp),
            icon = { Radar(72.dp) },
            title = { Text("Pair with ${n.name}", textAlign = TextAlign.Center) },
            text = {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Enter this pairing code on ${n.name}:", textAlign = TextAlign.Center)
                    Text(
                        settings.passphrase, fontFamily = FontFamily.Monospace, fontSize = 32.sp, fontWeight = FontWeight.ExtraBold,
                        letterSpacing = 3.sp, color = cs.primary, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(cs.primary.copy(alpha = 0.10f))
                            .border(1.5.dp, cs.primary.copy(alpha = 0.6f), RoundedCornerShape(18.dp))
                            .clickable { copyText(ctx, settings.passphrase) }.padding(vertical = 18.dp)
                    )
                    Dim("Tap the code to copy it.")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PulseDot(true)
                        Spacer(Modifier.width(10.dp))
                        Dim("Waiting for ${n.name}…")
                    }
                }
            },
            confirmButton = { TextButton(onClick = cancel) { Text("Cancel") } }
        )
    }
    if (enterManual) EnterCodeDialog(
        title = "Enter pairing code",
        hint = "Enter the pairing code shown on your other device.",
        onDismiss = { enterManual = false },
        onConfirm = { if (usePairingCode(ctx, it)) enterManual = false }
    )
}

@Composable
private fun TransferCard(t: Transfer) {
    val cs = MaterialTheme.colorScheme
    val live = t.status == "waiting" || t.status == "active"
    val target = if (t.size > 0) (t.done.toFloat() / t.size).coerceIn(0f, 1f) else if (t.status == "done") 1f else 0f
    val p by animateFloatAsState(target, tween(300), label = "progress")
    val (label, color) = when (t.status) {
        "waiting" -> "Queued" to cs.primary
        "active" -> "Transferring" to cs.primary
        "done" -> "Complete" to OkGreen
        "rejected" -> "Declined" to cs.error
        "cancelled" -> "Cancelled" to cs.outline
        else -> if (t.canResume) "Paused" to WarnAmber else "Failed" to cs.error
    }
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconBubble(if (t.outgoing) Icons.AutoMirrored.Filled.Send else DownloadIcon, cs.primary, 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(t.name, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Dim((if (t.outgoing) "To " else "From ") + t.peer)
            }
            if (live && t.status == "active") Text("${(target * 100).toInt()}%", color = cs.primary, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, fontSize = 18.sp)
        }
        if (t.status == "waiting") LinearProgressIndicator(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)))
        else if (live) LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Pill(label, color)
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f)) {
                Dim(
                    when (t.status) {
                        "waiting" -> if (t.outgoing) "Waiting for ${t.peer} to accept…" else "Starting…"
                        "active" -> "${fmtSize(t.done)} / ${fmtSize(t.size)}"
                        "done" -> "Done · ${fmtSize(t.size)}"
                        "rejected" -> "Declined by ${t.peer}"
                        "cancelled" -> "Cancelled"
                        else -> if (t.canResume) "Connection lost · continues automatically, or press Resume" else "Failed"
                    }
                )
            }
            if (live) TextButton(onClick = { Transfers.cancel(t.id) }) { Text("Cancel") }
            else if (t.canResume) Button(onClick = { Transfers.resume(t.id) }, shape = RoundedCornerShape(12.dp)) { Text("Resume") }
        }
    }
}

@Composable
private fun FilesPage(pad: PaddingValues) {
    val ctx = LocalContext.current
    val s by Hub.settings.collectAsState()
    val transfers by Transfers.transfers.collectAsState()
    var filter by remember { mutableStateOf("all") }
    val shown = when (filter) {
        "sent" -> transfers.filter { it.outgoing }
        "received" -> transfers.filter { !it.outgoing }
        "queued" -> transfers.filter { it.status == "waiting" }
        else -> transfers
    }
    Page("Files", "Send with Share → Y Connect, or “File” on a device.", pad) {
        Card {
            SettingRow(DownloadIcon, "Accept incoming files", "Saved to Downloads/YConnect", s.acceptFiles) { Hub.updateSettings(s.copy(acceptFiles = it)) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { ctx.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }, shape = RoundedCornerShape(14.dp)) {
                    Icon(FolderIcon, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Open Downloads")
                }
                if (transfers.any { it.status != "waiting" && it.status != "active" }) OutlinedButton(onClick = { Transfers.clearFinished() }, shape = RoundedCornerShape(14.dp)) { Text("Clear finished") }
            }
        }
        SectionLabel("Transfers")
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                Triple("all", "All", transfers.size),
                Triple("sent", "Sent", transfers.count { it.outgoing }),
                Triple("received", "Received", transfers.count { !it.outgoing }),
                Triple("queued", "Queued", transfers.count { it.status == "waiting" }),
            ).forEach { (id, label, n) ->
                if (filter == id) Button(onClick = { filter = id }, shape = RoundedCornerShape(14.dp)) { Text("$label $n") }
                else OutlinedButton(onClick = { filter = id }, shape = RoundedCornerShape(14.dp)) { Text("$label $n") }
            }
        }
        if (transfers.isEmpty()) Card { EmptyState(Icons.AutoMirrored.Filled.Send, "No transfers yet", "Use “File” or “Folder” on a device, or share a file to Y Connect.") }
        else if (shown.isEmpty()) Card { EmptyState(Icons.AutoMirrored.Filled.Send, "No $filter transfers", "Nothing here right now.") }
        shown.forEachIndexed { i, t -> key(t.id) { Appear(minOf(i, 6) * 40) { TransferCard(t) } } }
    }
}

@Composable
private fun ActivityPage(pad: PaddingValues) {
    val cs = MaterialTheme.colorScheme
    val log by Hub.log.collectAsState()
    val fmt = remember { SimpleDateFormat("HH:mm:ss", Locale.getDefault()) }
    var filter by rememberSaveable { mutableStateOf("all") }
    val shown = (if (filter == "warn") log.filter { it.kind == "warn" } else log).take(30)
    Page("Activity", "Recent events on this phone.", pad) {
        Segmented(listOf("all" to "All", "warn" to "Warnings"), filter) { filter = it }
        Card {
            if (shown.isEmpty()) EmptyState(
                PulseIcon,
                if (filter == "warn") "No warnings" else "Nothing yet",
                if (filter == "warn") "Everything is running smoothly." else "Events will show up here as they happen."
            )
            shown.forEach { l ->
                val warn = l.kind == "warn"
                val c = if (warn) cs.error else cs.primary
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                    Box(Modifier.padding(top = 6.dp).size(10.dp).clip(CircleShape).background(c))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(l.title, fontWeight = FontWeight.Bold, color = if (warn) cs.error else cs.onSurface, modifier = Modifier.weight(1f))
                            if (l.count > 1) Pill("×${l.count}", WarnAmber)
                        }
                        if (l.text.isNotBlank()) Dim(l.text)
                        Dim(fmt.format(Date(l.time)) + " · " + l.kind)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsPage(pad: PaddingValues, notifAccess: Boolean) {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val s by Hub.settings.collectAsState()
    var name by remember(s.name) { mutableStateOf(s.name) }
    var pass by remember(s.passphrase) { mutableStateOf(s.passphrase) }
    var show by remember { mutableStateOf(false) }
    Page("Settings", "Name this phone and set the shared pairing code.", pad) {
        Card("Appearance") {
            Segmented(listOf("system" to "System", "light" to "Light", "dark" to "Dark"), s.theme) { Hub.updateSettings(s.copy(theme = it)) }
            ToggleRow(
                "Use system colors",
                if (android.os.Build.VERSION.SDK_INT >= 31) "Colors from your wallpaper. Off uses Y Connect blue." else "Needs Android 12 or newer. Y Connect blue is used.",
                s.systemColors && android.os.Build.VERSION.SDK_INT >= 31
            ) { Hub.updateSettings(s.copy(systemColors = it)) }
        }
        Card("This device") {
            OutlinedTextField(name, { name = it }, label = { Text("Device name") }, singleLine = true, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                pass, { pass = it }, label = { Text("Pairing code (same on every device)") }, singleLine = true,
                shape = RoundedCornerShape(14.dp),
                visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = {
                    if (name.isNotBlank() && pass.isNotBlank()) { Hub.updateSettings(s.copy(name = name.trim(), passphrase = pass.trim())); toast(ctx, "Saved") }
                }, shape = RoundedCornerShape(14.dp)) { Text("Save") }
                OutlinedButton(onClick = { show = !show }, shape = RoundedCornerShape(14.dp)) { Text(if (show) "Hide" else "Show") }
                OutlinedButton(onClick = {
                    val a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
                    val r = java.security.SecureRandom()
                    val c = (1..8).map { a[r.nextInt(a.length)] }.joinToString("")
                    pass = c.take(4) + "-" + c.drop(4); show = true
                }, shape = RoundedCornerShape(14.dp)) { Text("New") }
                IconButton(onClick = { copyText(ctx, pass) }) { Icon(CopyIcon, "Copy code", tint = cs.primary) }
            }
        }
        Deferred(1) { Card("Sync") {
            SettingRow(ClipboardIcon, "Clipboard sync", "Copy here, paste anywhere", s.clipboardSync) { Hub.updateSettings(s.copy(clipboardSync = it)) }
            SettingRow(BellIcon, "Notifications", "Send this phone's notifications and show your other devices'", s.notifySync) { Hub.updateSettings(s.copy(notifySync = it)) }
            SettingRow(BatteryIcon, "Battery level", "Share this phone's battery and show your other devices'", s.batterySync) { Hub.updateSettings(s.copy(batterySync = it)) }
            SettingRow(ClipboardIcon, "Send clipboard automatically", "Phone → computer without tapping. Needs “Display over other apps”.", s.autoClipboard) { Hub.updateSettings(s.copy(autoClipboard = it)) }
        } }
        Deferred(2) { Card("Permissions") {
            if (s.autoClipboard) {
                val overlayOk by ClipboardWatcher.overlayGranted.collectAsState()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Display over other apps", fontWeight = FontWeight.SemiBold)
                        Dim("Lets Y Connect read the clipboard in the background.")
                    }
                    if (overlayOk) Pill("On", OkGreen)
                    else Button(onClick = {
                        ctx.startActivity(Intent(AndroidSettings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:" + ctx.packageName)))
                    }, shape = RoundedCornerShape(12.dp)) { Text("Allow") }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Notification access", fontWeight = FontWeight.SemiBold)
                    Dim(if (notifAccess) "This phone can forward notifications." else "Off, so this phone can't forward notifications yet.")
                }
                if (notifAccess) Pill("Granted", OkGreen)
                else Button(onClick = { ctx.startActivity(Intent(AndroidSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }, shape = RoundedCornerShape(12.dp)) { Text("Grant") }
            }
            OutlinedButton(onClick = { ctx.startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }, shape = RoundedCornerShape(14.dp)) { Text("Battery: set to unrestricted") }
            Dim("Tip: add the “Send clipboard” tile to quick settings. It also works if automatic sending is off or blocked by your phone.")
        } }
    }
}

@Composable
private fun LinkCard(label: String, sub: String, ic: ImageVector, url: String) {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    Card {
        Row(Modifier.fillMaxWidth().bounceClick { openLink(ctx, url) }, verticalAlignment = Alignment.CenterVertically) {
            IconBubble(ic, cs.primary, 46.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) { Text(label, fontWeight = FontWeight.Bold); Dim(sub) }
            Text("→", color = cs.primary, fontSize = 20.sp)
        }
    }
}

@Composable
private fun LicenseBlock(title: String, file: String) {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    var open by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(open) {
        if (open && text == null) text = withContext(Dispatchers.IO) {
            try { ctx.assets.open("licenses/$file").bufferedReader().use { it.readText() } } catch (_: Exception) { "License file not found." }
        }
    }
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { open = !open }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            Text(if (open) "▾" else "▸", color = cs.primary)
        }
        if (open) Box(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
            Text(text ?: "Loading…", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant)
        }
    }
}

/** Only the basics are shown. The long technical list is added to the debug report when it is copied or shared. */
@Composable
private fun DeviceInfoCard() {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val rows = remember { DeviceInfo.brief(ctx) }
    var busy by remember { mutableStateOf(false) }
    // the full report runs getprop and reads /proc, so it is built on a background thread, only when asked for
    fun report(then: (String) -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            val text = withContext(Dispatchers.IO) { DeviceInfo.report(DeviceInfo.collect(ctx), Hub.log.value) }
            busy = false
            then(text)
        }
    }
    Card("This device") {
        rows.forEach { (k, v) ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Text(k, color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.weight(0.35f).padding(end = 8.dp))
                Text(v, fontSize = 13.sp, textAlign = TextAlign.End, modifier = Modifier.weight(0.65f))
            }
        }
        Dim("Reporting a bug? The debug report adds more technical details. It never includes your device name, IP addresses, pairing code or the text of clipboard and notification entries.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { report { copyText(ctx, it) } }, enabled = !busy, shape = RoundedCornerShape(14.dp)) { Text(if (busy) "Preparing…" else "Copy debug report") }
            OutlinedButton(onClick = {
                report { text ->
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, "Y Connect debug report")
                        .putExtra(Intent.EXTRA_TEXT, text)
                    try { ctx.startActivity(Intent.createChooser(send, "Share debug report").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    catch (_: Exception) { toast(ctx, "No app can share this") }
                }
            }, enabled = !busy, shape = RoundedCornerShape(14.dp)) { Text("Share") }
        }
    }
}

/** "Check for updates" plus the opt-in switch that checks about once a day and notifies when a new release is out. */
@Composable
private fun UpdateCard() {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val current = remember { Updates.currentVersion(ctx) }
    val known by Updates.available.collectAsState()
    var auto by remember { mutableStateOf(Updates.autoEnabled(ctx)) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<Updates.Result?>(null) }
    var last by remember { mutableStateOf(Updates.lastChecked(ctx)) }
    val fmt = remember { SimpleDateFormat("d MMM, HH:mm", Locale.getDefault()) }
    val newer = (result as? Updates.Result.Newer) ?: known

    fun check() {
        if (busy) return
        busy = true
        scope.launch {
            val r = withContext(Dispatchers.IO) { Updates.fetch(ctx) }
            result = r
            last = Updates.lastChecked(ctx)
            busy = false
            if (r is Updates.Result.Newer && Updates.autoEnabled(ctx)) Updates.notifyOnce(ctx, r)
        }
    }

    Card("Updates") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 10.dp)) {
                Text(if (newer != null) "${newer.tag} is available" else "You have $current", fontWeight = FontWeight.SemiBold)
                val r = result
                if (r is Updates.Result.Failed) Dim(r.why, cs.error)
                else Dim(
                    when {
                        busy -> "Checking GitHub…"
                        newer != null -> "You have $current."
                        r is Updates.Result.UpToDate -> "You're up to date."
                        last > 0 -> "Last checked ${fmt.format(Date(last))}"
                        else -> "Not checked yet"
                    }
                )
            }
            Button(onClick = { check() }, enabled = !busy, shape = RoundedCornerShape(14.dp)) { Text(if (busy) "Checking…" else "Check now") }
        }
        newer?.let { n ->
            if (n.notes.isNotBlank()) Dim(n.notes.take(360) + if (n.notes.length > 360) "…" else "")
            Button(onClick = { Updates.openRelease(ctx, n.url) }, shape = RoundedCornerShape(14.dp)) {
                Icon(DownloadIcon, null, Modifier.size(17.dp))
                Spacer(Modifier.width(6.dp))
                Text("Open download page")
            }
        }
        SettingRow(
            BellIcon, "Notify me about new releases",
            "Checks GitHub about once a day when Y Connect opens. Off by default, since this is the only thing that uses the internet.",
            auto
        ) { on ->
            auto = on
            Updates.setAuto(ctx, on)
            if (on) check()
        }
    }
}

@Composable
private fun AboutPage(pad: PaddingValues) {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val version = remember { Updates.currentVersion(ctx) }
    Page("About", "Version $version", pad) {
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.logo), "Y Connect", Modifier.size(68.dp).clip(RoundedCornerShape(18.dp)), contentScale = ContentScale.Fit)
                Spacer(Modifier.width(14.dp))
                Column {
                    Text(
                        "Y Connect",
                        style = TextStyle(brush = Brush.horizontalGradient(listOf(cs.primary, cs.tertiary)), fontSize = 24.sp, fontWeight = FontWeight.Bold)
                    )
                    Dim("Notifications, clipboard and files between your devices over Wi-Fi. No cloud, no account.")
                }
            }
            Dim("Everything is end-to-end encrypted with AES-256-GCM using a key derived from your pairing code.")
        }
        UpdateCard()
        Deferred(1) { DeviceInfoCard() }
        Deferred(2) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                SectionLabel("Contact")
                LinkCard("Discord", "Message me on Discord", DiscordIcon, DISCORD_URL)
                LinkCard("Reddit", "u/yokeswaran_n", RedditIcon, REDDIT_URL)
            }
        }
        Deferred(3) {
            Card("Licenses") {
                Dim("Free software, licensed under the GNU GPL v3.0 or later.")
                LicenseBlock("GNU GPL v3.0 (project license)", "LICENSE-GPL-3.0.txt")
                LicenseBlock("Third-party notices", "THIRD-PARTY-NOTICES.txt")
                Dim("Built with open-source software, thank you to its authors:")
                Dim("• Java-WebSocket (MIT)\n• Kotlin and kotlinx.coroutines (Apache-2.0)\n• Jetpack Compose, Material 3, Material Icons (Apache-2.0)\n• AndroidX Core, Activity, Lifecycle (Apache-2.0)\n• Android Open Source Project (Apache-2.0)\n• Android Gradle Plugin and Gradle, build tools (Apache-2.0)")
            }
        }
        Text("© 2026 Yokeswaran N", color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
    }
}
