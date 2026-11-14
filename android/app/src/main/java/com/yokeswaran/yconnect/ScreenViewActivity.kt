// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.Activity
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.abs

/**
 * Full-screen picture of the other device's screen. Leaving this screen stops the session.
 * When the other device allows control, a "Control" button appears; while it is on:
 *   tap = click, drag = drag, hold = right click, two fingers = scroll, keyboard button = type on the other device.
 */
class ScreenViewActivity : Activity(), Screen.Listener {
    private lateinit var image: ImageView
    private lateinit var bar: LinearLayout
    private lateinit var ctlBtn: TextView
    private lateinit var kbBtn: TextView
    private lateinit var catcher: KeyCatcher
    private val decoding = AtomicBoolean(false)
    private val ui = Handler(Looper.getMainLooper())
    private var controlling = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Screen.viewConn == null) { finish(); return }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        image = ImageView(this).apply {
            setBackgroundColor(Color.BLACK)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        catcher = KeyCatcher(this) { ev -> Screen.sendInput(ev) }
        ctlBtn = pill("Control") { setControlling(!controlling) }
        kbBtn = pill("Keyboard") { showKeyboard() }
        bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(ctlBtn); addView(kbBtn)
        }
        val root = FrameLayout(this)
        root.addView(image, FrameLayout.LayoutParams(-1, -1))
        root.addView(catcher, FrameLayout.LayoutParams(1, 1))
        root.addView(bar, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { setMargins(0, dp(28), dp(10), 0) })
        setContentView(root)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, image).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        image.setOnTouchListener { _, e -> onTouch(e) }
        Screen.listener = this
        refreshBar()
        if (Screen.hasPicture()) pump()
    }

    override fun onPicture() = pump()

    override fun onEnded() { runOnUiThread { if (!isFinishing) finish() } }

    override fun onControl() { runOnUiThread { if (!Screen.viewCtl) setControlling(false); refreshBar() } }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun pill(label: String, click: () -> Unit) = TextView(this).apply {
        text = label; setTextColor(Color.WHITE); textSize = 13f
        setPadding(dp(14), dp(8), dp(14), dp(8))
        background = GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(0x99282828.toInt()) }
        alpha = 0.7f
        (layoutParams ?: LinearLayout.LayoutParams(-2, -2)).also { (it as LinearLayout.LayoutParams).setMargins(dp(4), 0, 0, 0); layoutParams = it }
        setOnClickListener { click() }
    }
    private fun refreshBar() {
        bar.visibility = if (Screen.viewCtl) View.VISIBLE else View.GONE
        ctlBtn.text = if (controlling) "Controlling — tap to stop" else "Control"
        (ctlBtn.background as GradientDrawable).setColor(if (controlling) 0xFF1E88E5.toInt() else 0x99282828.toInt())
        kbBtn.visibility = if (controlling) View.VISIBLE else View.GONE
    }
    private fun setControlling(on: Boolean) {
        if (on && !Screen.viewCtl) return
        if (controlling && !on) { cancelTouch(); Screen.sendInput(JSONObject().put("k", "release")) }
        controlling = on
        if (!on) hideKeyboard()
        refreshBar()
    }
    private fun showKeyboard() {
        catcher.requestFocus()
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(catcher, InputMethodManager.SHOW_IMPLICIT)
    }
    private fun hideKeyboard() {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(catcher.windowToken, 0)
    }

    /* ---------- touch -> mouse ---------- */
    private var downX = 0f; private var downY = 0f
    private var sentDown = false
    private var longPressed = false
    private var scrolling = false
    private var scrollY = 0f; private var scrollX = 0f
    private val slop by lazy { ViewConfiguration.get(this).scaledTouchSlop.toFloat() }
    private val longPress = Runnable {
        if (!sentDown && !scrolling) {
            longPressed = true
            pos(downX, downY)?.let { p ->
                send("down", p, 2); send("up", p, 2)
            }
        }
    }

    /** Position inside the picture as 0..1 (the image is letterboxed), or null on the black bars. */
    private fun pos(x: Float, y: Float): FloatArray? {
        val d = image.drawable ?: return null
        val inv = Matrix()
        if (!image.imageMatrix.invert(inv)) return null
        val pt = floatArrayOf(x, y)
        inv.mapPoints(pt)
        val nx = pt[0] / d.intrinsicWidth; val ny = pt[1] / d.intrinsicHeight
        return if (nx < 0f || ny < 0f || nx > 1f || ny > 1f) null else floatArrayOf(nx, ny)
    }
    private fun send(k: String, p: FloatArray, b: Int = -1) {
        val e = JSONObject().put("k", k).put("x", p[0].toDouble()).put("y", p[1].toDouble())
        if (b >= 0) e.put("b", b)
        Screen.sendInput(e)
    }
    private fun cancelTouch() {
        ui.removeCallbacks(longPress)
        if (sentDown) pos(downX, downY)?.let { send("up", it, 0) }
        sentDown = false; scrolling = false
    }

    private fun onTouch(e: MotionEvent): Boolean {
        if (!controlling) return false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = e.x; downY = e.y; sentDown = false; longPressed = false; scrolling = false
                ui.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (e.pointerCount == 2) {
                    ui.removeCallbacks(longPress)
                    if (sentDown) { pos(e.getX(0), e.getY(0))?.let { send("up", it, 0) }; sentDown = false }
                    scrolling = true
                    scrollX = (e.getX(0) + e.getX(1)) / 2; scrollY = (e.getY(0) + e.getY(1)) / 2
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (scrolling && e.pointerCount >= 2) {
                    val cx = (e.getX(0) + e.getX(1)) / 2; val cy = (e.getY(0) + e.getY(1)) / 2
                    val step = 48f * resources.displayMetrics.density / 2
                    val ny = ((scrollY - cy) / step).toInt(); val nx = ((scrollX - cx) / step).toInt()
                    if (ny != 0 || nx != 0) {
                        pos(cx, cy)?.let { p -> Screen.sendInput(JSONObject().put("k", "wheel").put("x", p[0].toDouble()).put("y", p[1].toDouble()).put("dx", nx).put("dy", ny)) }
                        if (ny != 0) scrollY = cy; if (nx != 0) scrollX = cx
                    }
                } else if (!scrolling && !longPressed) {
                    val moved = abs(e.x - downX) > slop || abs(e.y - downY) > slop
                    if (!sentDown && moved) {
                        ui.removeCallbacks(longPress)
                        pos(downX, downY)?.let { send("move", it); send("down", it, 0); sentDown = true }
                    }
                    if (sentDown) pos(e.x, e.y)?.let { send("move", it) }
                }
            }
            MotionEvent.ACTION_UP -> {
                ui.removeCallbacks(longPress)
                if (sentDown) pos(e.x, e.y)?.let { send("up", it, 0) }
                else if (!scrolling && !longPressed) pos(downX, downY)?.let { send("move", it); send("down", it, 0); send("up", it, 0) } // tap = click
                sentDown = false; scrolling = false
            }
            MotionEvent.ACTION_CANCEL -> cancelTouch()
        }
        return true
    }

    /** Hardware keyboards: letters become text, the rest are sent as key presses. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (controlling && event.keyCode != KeyEvent.KEYCODE_BACK && event.keyCode != KeyEvent.KEYCODE_VOLUME_UP && event.keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (catcher.handleKey(event)) return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** Decodes on its own thread and always shows the newest picture; older ones that were not shown yet are skipped. */
    private fun pump() {
        if (!decoding.compareAndSet(false, true)) return
        thread(isDaemon = true, name = "yconnect-screen-decode") {
            try {
                while (true) {
                    val jpeg = Screen.takePicture() ?: break
                    val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: continue
                    runOnUiThread { if (!isDestroyed) image.setImageBitmap(bmp) }
                }
            } finally {
                decoding.set(false)
                if (Screen.hasPicture()) pump()
            }
        }
    }

    override fun onDestroy() {
        ui.removeCallbacks(longPress)
        if (controlling) Screen.sendInput(JSONObject().put("k", "release"))
        if (Screen.listener === this) Screen.listener = null
        if (isFinishing) Screen.endViewing(true) // the user left: tell the sharer to stop
        super.onDestroy()
    }
}

/** An invisible view that receives the on-screen keyboard's input and turns it into screen-input events. */
class KeyCatcher(ctx: Context, private val out: (JSONObject) -> Unit) : View(ctx) {
    init { isFocusable = true; isFocusableInTouchMode = true }
    override fun onCheckIsTextEditor() = true

    private fun key(code: String, ch: String = "") {
        out(JSONObject().put("k", "key").put("code", code).put("d", true).put("ch", ch))
        out(JSONObject().put("k", "key").put("code", code).put("d", false))
    }
    private fun text(s: String) { if (s.isNotEmpty()) out(JSONObject().put("k", "text").put("s", s)) }

    /** Returns true when the key was used. */
    fun handleKey(e: KeyEvent): Boolean {
        val code = when (e.keyCode) {
            KeyEvent.KEYCODE_DEL -> "Backspace"
            KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
            KeyEvent.KEYCODE_TAB -> "Tab"
            KeyEvent.KEYCODE_ESCAPE -> "Escape"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_MOVE_HOME -> "Home"
            KeyEvent.KEYCODE_MOVE_END -> "End"
            else -> null
        }
        if (e.action != KeyEvent.ACTION_DOWN) return code != null || e.unicodeChar > 0
        if (code != null) { key(code); return true }
        val u = e.unicodeChar
        if (u > 0 && !e.isCtrlPressed && !e.isAltPressed) { text(String(Character.toChars(u))); return true }
        return false
    }

    override fun onCreateInputConnection(o: EditorInfo): InputConnection {
        o.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        o.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_ACTION_NONE
        return object : BaseInputConnection(this, false) {
            override fun commitText(t: CharSequence?, newCursorPosition: Int): Boolean { text(t?.toString() ?: ""); return true }
            override fun setComposingText(t: CharSequence?, newCursorPosition: Int): Boolean = true
            override fun deleteSurroundingText(before: Int, after: Int): Boolean { repeat(before.coerceIn(0, 50)) { key("Backspace") }; repeat(after.coerceIn(0, 50)) { key("Delete") }; return true }
            override fun sendKeyEvent(e: KeyEvent): Boolean = handleKey(e)
            override fun performEditorAction(a: Int): Boolean { key("Enter"); return true }
        }
    }
}
