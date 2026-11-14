// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Carries out the touches and keys of a remote viewer (screen-input messages, see desktop/inputctl.js) on this phone.
 * Android only allows this through an accessibility service, so the user switches it on by hand in
 * Settings > Accessibility. [Screen] hands events over only while the user has "Allow remote control" on, the screen is
 * being shared with that device and control was not stopped; every event is validated again here.
 *
 *   move / down / up   one continued gesture stroke that follows the pointer (drag, tap, long press)
 *   wheel              a short swipe
 *   text / key         inserted into the focused text field
 *   nav                back / home / recents
 */
class RemoteControlService : AccessibilityService() {
    companion object {
        @Volatile var instance: RemoteControlService? = null
        const val MAX_TEXT = 256
    }

    private val ui = Handler(Looper.getMainLooper())
    private var stroke: GestureDescription.StrokeDescription? = null
    private var last = floatArrayOf(0f, 0f)
    private var target: FloatArray? = null
    private var ended = false
    private var inFlight = false
    private var downAt = 0L

    override fun onServiceConnected() { instance = this; Hub.addLog("info", "Remote control service is on", "") }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() { releaseAll() }
    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        Screen.setControl(false, true)
        return super.onUnbind(intent)
    }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }

    /** Entry point, any thread. */
    fun handle(ev: JSONObject) { ui.post { try { run(ev) } catch (_: Exception) {} } }

    fun releaseAll() { ui.post { if (stroke != null && !ended) { ended = true; pump() } } }

    private fun size(): IntArray {
        @Suppress("DEPRECATION")
        val dm = DisplayMetrics().also { getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(it) }
        return intArrayOf(dm.widthPixels, dm.heightPixels)
    }
    private fun px(ev: JSONObject): FloatArray? {
        val x = ev.optDouble("x", Double.NaN); val y = ev.optDouble("y", Double.NaN)
        if (x.isNaN() || y.isNaN()) return null
        val s = size()
        return floatArrayOf((x.coerceIn(0.0, 1.0) * (s[0] - 1)).toFloat(), (y.coerceIn(0.0, 1.0) * (s[1] - 1)).toFloat())
    }

    private fun run(ev: JSONObject) {
        when (ev.optString("k")) {
            "down" -> { if (ev.optInt("b", 0) == 2) { back(); return }; val p = px(ev) ?: return; begin(p) }
            "move" -> { val p = px(ev) ?: return; if (stroke != null && !ended) { target = p; pump() } }
            "up" -> { if (ev.optInt("b", 0) == 2) return; val p = px(ev); if (stroke != null && !ended) { if (p != null) target = p; ended = true; pump() } }
            "release" -> releaseAll()
            "wheel" -> { val p = px(ev) ?: return; wheel(p, ev.optInt("dx", 0).coerceIn(-20, 20), ev.optInt("dy", 0).coerceIn(-20, 20)) }
            "text" -> { val t = ev.optString("s").filter { it >= ' ' || it == '\n' }.take(MAX_TEXT); if (t.isNotEmpty()) insert(t) }
            "key" -> key(ev)
            "nav" -> when (ev.optString("a")) {
                "back" -> back()
                "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
                "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            }
        }
    }
    private fun back() { performGlobalAction(GLOBAL_ACTION_BACK) }

    /* ---- pointer: one stroke that is continued as the pointer moves ---- */
    private fun begin(p: FloatArray) {
        stroke = null; target = null; ended = false; inFlight = false
        last = p
        val path = Path().apply { moveTo(p[0], p[1]) }
        val s = GestureDescription.StrokeDescription(path, 0, 50, true)
        stroke = s; downAt = System.currentTimeMillis()
        send(s)
    }
    private fun send(s: GestureDescription.StrokeDescription) {
        inFlight = true
        val ok = dispatchGesture(GestureDescription.Builder().addStroke(s).build(), object : GestureResultCallback() {
            override fun onCompleted(g: GestureDescription?) { inFlight = false; if (ended && target == null) stroke = null; pump() }
            override fun onCancelled(g: GestureDescription?) { inFlight = false; stroke = null; target = null }
        }, ui)
        if (!ok) { inFlight = false; stroke = null }
    }
    private fun pump() {
        val s = stroke ?: return
        if (inFlight) return
        val t = target
        if (t == null && !ended) return
        val path = Path().apply { moveTo(last[0], last[1]); if (t != null) lineTo(t[0], t[1]) }
        val more = !ended
        val dur = if (t != null) 16L else 8L
        val next = try { s.continueStroke(path, 0, dur, more) } catch (_: Exception) { stroke = null; return }
        if (t != null) last = t
        target = null
        stroke = next            // cleared when the last piece has been dispatched (see send)
        send(next)
    }

    private fun wheel(p: FloatArray, dx: Int, dy: Int) {
        if (stroke != null) return // a drag is going on
        val s = size()
        val step = s[1] * 0.12f
        val ex = (p[0] - dx * step).coerceIn(1f, (s[0] - 2).toFloat())
        val ey = (p[1] - dy * step).coerceIn(1f, (s[1] - 2).toFloat())
        if (abs(ex - p[0]) < 1f && abs(ey - p[1]) < 1f) return
        val path = Path().apply { moveTo(p[0], p[1]); lineTo(ex, ey) }
        val ms = max(120L, min(400L, 80L + 30L * max(abs(dx), abs(dy))))
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build(), null, null)
    }

    /* ---- keyboard ---- */
    private fun key(ev: JSONObject) {
        if (!ev.optBoolean("d", false)) return // act on key down only
        when (ev.optString("code")) {
            "Backspace" -> edit { t, a, b -> if (a != b) t.removeRange(a, b) to a else if (a > 0) t.removeRange(a - 1, a) to a - 1 else t to a }
            "Delete" -> edit { t, a, b -> if (a != b) t.removeRange(a, b) to a else if (a < t.length) t.removeRange(a, a + 1) to a else t to a }
            "ArrowLeft" -> edit { t, a, _ -> t to max(0, a - 1) }
            "ArrowRight" -> edit { t, a, b -> t to min(t.length, max(a, b) + 1) }
            "Home" -> edit { t, _, _ -> t to 0 }
            "End" -> edit { t, _, _ -> t to t.length }
            "Enter" -> enter()
            "Escape" -> back()
            "MetaLeft", "MetaRight" -> performGlobalAction(GLOBAL_ACTION_HOME)
            else -> {
                val ch = ev.optString("ch")
                if (ch.isNotEmpty() && ch.length <= 2 && !ev.optBoolean("ctrl", false)) insert(ch)
            }
        }
    }
    private fun focused(): AccessibilityNodeInfo? = try { findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable } } catch (_: Exception) { null }

    /** Changes the text of the focused field: [f] gets (text, selStart, selEnd) and returns (new text, new cursor). */
    private fun edit(f: (String, Int, Int) -> Pair<String, Int>) {
        val n = focused() ?: return
        val text = n.text?.toString() ?: ""
        val shown = n.isShowingHintText
        val base = if (shown) "" else text
        var a = if (shown) 0 else n.textSelectionStart
        var b = if (shown) 0 else n.textSelectionEnd
        if (a < 0 || b < 0) { a = base.length; b = base.length }
        val lo = min(a, b).coerceIn(0, base.length); val hi = max(a, b).coerceIn(0, base.length)
        val (nt, cur) = f(base, lo, hi)
        if (nt != base) n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, nt)
        })
        val c = cur.coerceIn(0, nt.length)
        n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, c)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, c)
        })
    }
    private fun insert(s: String) = edit { t, a, b -> (t.substring(0, a) + s + t.substring(b)) to (a + s.length) }
    private fun enter() {
        val n = focused() ?: return
        if (n.isMultiLine) { insert("\n"); return }
        if (android.os.Build.VERSION.SDK_INT >= 30) n.performAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
    }

    private fun String.removeRange(a: Int, b: Int) = substring(0, a) + substring(b)
}
