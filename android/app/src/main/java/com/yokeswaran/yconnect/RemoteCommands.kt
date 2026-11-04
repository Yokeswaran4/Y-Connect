// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import org.java_websocket.WebSocket
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.concurrent.thread

/** A command the user keeps for later. */
data class SavedCommand(
    val id: String,
    val label: String,
    val text: String,
    val shell: String = "default",   // "default" | "powershell" (Windows only)
)

/** Plain-language reason and remedy that go with a failure. */
data class RunError(val kind: String, val why: String, val fix: String)

/** status: running | done | failed */
data class RunEntry(
    val rid: String,
    val peerId: String,
    val peer: String,
    val text: String,
    val status: String,
    val code: Int = 0,
    val stdout: String = "",
    val stderr: String = "",
    val truncated: Boolean = false,
    val ms: Long = 0,
    val error: RunError? = null,
)

/**
 * Sends commands to a connected computer and shows what came back. Removing files is not supported:
 * delete commands are refused here before anything is sent, and the computer refuses them as well.
 * The computer does the work (see desktop/remote.js) and answers with `cmd-result`;
 * when something fails the answer carries the reason and how to fix it. Problems that can only be
 * noticed on this side (not connected, no answer, connection lost) are explained here.
 *
 * Protocol: cmd-run {rid,command,shell,timeout} | cmd-cancel {rid}  ->  cmd-result {rid,ok,code,stdout,stderr,truncated,ms,error{kind,why,fix}}
 */
object RemoteCommands {
    val saved = MutableStateFlow<List<SavedCommand>>(emptyList())
    val recent = MutableStateFlow<List<SavedCommand>>(emptyList())
    val runs = MutableStateFlow<List<RunEntry>>(emptyList())

    private const val MAX_RUNS = 20
    private const val MAX_RECENT = 8
    private var prefs: android.content.SharedPreferences? = null

    fun load(ctx: Context) {
        val p = ctx.applicationContext.getSharedPreferences("yconnect", Context.MODE_PRIVATE)
        prefs = p
        saved.value = decode(p.getString("saved_cmds", null))
        recent.value = decode(p.getString("recent_cmds", null))
    }

    /* ---------- saved & recent ---------- */
    private fun decode(s: String?): List<SavedCommand> {
        if (s.isNullOrEmpty()) return emptyList()
        return try {
            val a = JSONArray(s)
            (0 until a.length()).mapNotNull { i ->
                val o = a.optJSONObject(i) ?: return@mapNotNull null
                val text = o.optString("text")
                if (text.isEmpty() || o.optString("kind") == "rm") return@mapNotNull null // removals saved by an older version are dropped
                SavedCommand(
                    o.optString("id").ifEmpty { UUID.randomUUID().toString() },
                    o.optString("label").ifEmpty { text.take(24) },
                    text, o.optString("shell", "default")
                )
            }
        } catch (_: Exception) { emptyList() }
    }

    private fun encode(l: List<SavedCommand>): String {
        val a = JSONArray()
        l.forEach {
            a.put(JSONObject().put("id", it.id).put("label", it.label)
                .put("text", it.text).put("shell", it.shell))
        }
        return a.toString()
    }

    private fun persist() {
        prefs?.edit()?.putString("saved_cmds", encode(saved.value))?.putString("recent_cmds", encode(recent.value))?.apply()
    }

    @Synchronized
    fun save(label: String, text: String, shell: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        val name = label.trim().ifEmpty { t.take(24) }
        // saving the same thing again just renames it
        val same = saved.value.firstOrNull { it.text == t && it.shell == shell }
        saved.value = if (same != null) saved.value.map { if (it.id == same.id) it.copy(label = name) else it }
        else saved.value + SavedCommand(UUID.randomUUID().toString(), name, t, shell)
        persist()
    }

    @Synchronized
    fun delete(id: String) {
        saved.value = saved.value.filter { it.id != id }
        persist()
    }

    @Synchronized
    private fun addRecent(text: String, shell: String) {
        val c = SavedCommand(UUID.randomUUID().toString(), text.take(24), text, shell)
        recent.value = (listOf(c) + recent.value.filterNot { it.text == text }).take(MAX_RECENT)
        persist()
    }

    @Synchronized
    fun clearRecent() { recent.value = emptyList(); persist() }

    /* ---------- running ---------- */
    private fun short() = UUID.randomUUID().toString().replace("-", "").take(12)

    @Synchronized
    private fun put(e: RunEntry) { runs.value = (listOf(e) + runs.value).take(MAX_RUNS) }

    @Synchronized
    private fun update(rid: String, f: (RunEntry) -> RunEntry) {
        runs.value = runs.value.map { if (it.rid == rid) f(it) else it }
    }

    @Synchronized
    fun clearRuns() { runs.value = runs.value.filter { it.status == "running" } }

    private fun failNow(peer: Peer, text: String, e: RunError) =
        put(RunEntry(short(), peer.id, peer.name, text, "failed", -1, error = e))

    /* ---------- guard rails (the computer checks the same things, so this is a second lock) ---------- */
    private const val SEP = "(?:^|[\\s;&|(`'\"])"
    private const val END = "(?=$|[\\s;&|)`'\"])"
    private val ELEVATE = Regex(SEP + "(sudo|su|doas|pkexec|runas|gsudo)(?:\\.exe)?" + END, RegexOption.IGNORE_CASE)
    private val DELETE = Regex(SEP + "(rm|rmdir|unlink|shred|srm|rimraf|trash|trash-put|del|erase|rd|remove-item|ri|clear-recyclebin)(?:\\.exe)?" + END, RegexOption.IGNORE_CASE)
    private val DELETE_FIND = Regex("\\bfind\\b[^\\n]*\\s-delete\\b|\\s-exec\\s+(?:rm|shred)\\b", RegexOption.IGNORE_CASE)

    /** Why a command must not be sent, or null when it may go. Best-effort guard rail, not a sandbox. */
    fun blockReason(cmd: String): RunError? {
        DELETE.find(cmd)?.let { return deleteError(it.groupValues[1]) }
        if (DELETE_FIND.containsMatchIn(cmd)) return deleteError("find -delete")
        ELEVATE.find(cmd)?.let {
            return RunError("elevation", "\"${it.groupValues[1]}\" asks for administrator / root rights. Commands only run as a normal user, because nobody can type a password remotely.",
                "Remove the elevation part, or run this command directly on the computer.")
        }
        return null
    }

    private fun deleteError(what: String) = RunError("removal-blocked",
        "The command contains \"$what\", which deletes files. Deleting files from the phone is not allowed.",
        "Delete files directly on the computer, or use a command that does not remove anything.")

    /** Sends the request. The result arrives later in [runs]. */
    fun run(peer: Peer, text: String, shell: String = "default", timeoutSec: Int = 30) {
        val t = text.trim()
        if (t.isEmpty()) return
        addRecent(t, shell)
        blockReason(t)?.let { failNow(peer, t, it); Hub.addLog("warn", "Command not sent", t.replace(Regex("\\s+"), " ").take(60)); return }
        val conn = Hub.byId[peer.id]
        if (conn == null || !conn.isOpen) {
            failNow(peer, t, RunError("not-connected",
                "${peer.name} is not connected right now, so the request could not be sent.",
                "Open Y Connect on ${peer.name}, make sure both devices are on the same Wi-Fi, and wait until it shows as connected on the Devices tab."))
            return
        }
        val rid = short()
        put(RunEntry(rid, peer.id, peer.name, t, "running"))
        val msg = JSONObject().put("rid", rid).put("type", "cmd-run").put("command", t).put("shell", shell).put("timeout", timeoutSec)
        Hub.sendJson(conn, msg)
        Hub.addLog("cmd", "Command sent to ${peer.name}", t.replace(Regex("\\s+"), " ").take(60))
        // if nothing comes back the computer is probably an older version, asleep, or the link dropped
        thread(isDaemon = true, name = "yconnect-cmd-watch") {
            try { Thread.sleep((timeoutSec + 15) * 1000L) } catch (_: InterruptedException) { return@thread }
            if (runs.value.any { it.rid == rid && it.status == "running" }) {
                update(rid) {
                    it.copy(status = "failed", code = -1, error = RunError("no-reply",
                        "${peer.name} did not answer in time. Usual causes: it is an older Y Connect version without remote commands (old versions silently ignore the request), the computer went to sleep, or the Wi-Fi dropped.",
                        "Update Y Connect on ${peer.name} to this version, wake it up, check the Wi-Fi, then try again."))
                }
            }
        }
    }

    fun cancel(rid: String) {
        val e = runs.value.firstOrNull { it.rid == rid && it.status == "running" } ?: return
        val conn = Hub.byId[e.peerId] ?: return
        Hub.sendJson(conn, JSONObject().put("type", "cmd-cancel").put("rid", rid))
    }

    /** A result (or a request, which phones never run) came in from [conn]. */
    fun onMessage(conn: WebSocket, j: JSONObject) {
        val rid = j.optString("rid")
        when (j.optString("type")) {
            "cmd-result" -> {
                val from = Hub.connInfo[conn]?.id ?: return
                val e = runs.value.firstOrNull { it.rid == rid && it.peerId == from } ?: return
                val err = j.optJSONObject("error")?.let {
                    RunError(it.optString("kind"), it.optString("why"), it.optString("fix"))
                }
                val ok = j.optBoolean("ok") && err == null
                update(e.rid) {
                    it.copy(
                        status = if (ok) "done" else "failed", code = j.optInt("code", 0),
                        stdout = j.optString("stdout"), stderr = j.optString("stderr"),
                        truncated = j.optBoolean("truncated"), ms = j.optLong("ms"),
                        error = if (ok) null else (err ?: RunError("exit-code", "The command finished with exit code ${j.optInt("code")}.", "Read the error output above and adjust the command."))
                    )
                }
            }
            "cmd-run", "cmd-rm" -> if (rid.isNotEmpty()) {
                // phones do not run commands or remove files
                Hub.sendJson(conn, JSONObject().put("type", "cmd-result").put("rid", rid).put("ok", false).put("code", -1)
                    .put("error", JSONObject().put("kind", "sender")
                        .put("why", "Android phones do not run commands or remove files for other devices.")
                        .put("fix", "Send commands from the phone to a Linux or Windows computer instead.")))
            }
        }
    }

    /** The connection to a computer ended while requests were still waiting. */
    fun onDisconnected(conn: WebSocket) {
        val id = Hub.connInfo[conn]?.id ?: return
        runs.value.filter { it.peerId == id && it.status == "running" }.forEach { e ->
            update(e.rid) {
                it.copy(status = "failed", code = -1, error = RunError("disconnected",
                    "The connection to ${it.peer} was lost before it answered. The command may or may not have run.",
                    "Wait until ${it.peer} shows as connected again (same Wi-Fi, Y Connect open), check the output on the computer if it matters, then run it again."))
            }
        }
    }
}
