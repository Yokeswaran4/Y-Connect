// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import android.app.DownloadManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.flow.MutableStateFlow
import org.java_websocket.WebSocket
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URLConnection
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.LockSupport
import kotlin.concurrent.thread

/** What the UI shows. status: waiting | active | done | failed | rejected | cancelled */
data class Transfer(
    val id: Int,
    val outgoing: Boolean,
    val peer: String,
    val name: String,
    val size: Long,
    val done: Long,
    val status: String,
    /** Failed because the connection dropped, and the file can be continued where it stopped. */
    val canResume: Boolean = false,
)

/** One file to send. [rel] is "Folder/sub/name" for folder transfers (empty for a single file). */
internal class SendSource(
    val uri: Uri,
    val name: String,
    val rel: String,
    val size: Long,
    val key: String,
    /** Already opened stream (share-sheet permissions vanish when that activity closes); used once. */
    @Volatile var first: InputStream? = null,
)

private class TransferState(
    val uid: Int,
    val tid: Long,
    val outgoing: Boolean,
    val conn: WebSocket,
    val peer: String,
    val peerId: String,
    val name: String,
    val size: Long,
    val key: String,
) {
    @Volatile var done = 0L
    @Volatile var status = "waiting"
    @Volatile var finished = false
    @Volatile var reason = ""
    @Volatile var offset = 0L            // outgoing: bytes the receiver already has
    @Volatile var disconnected = false   // the connection dropped (not the user's choice)
    @Volatile var ending = false         // incoming: file-end arrived, the file is being moved into Downloads
    var src: SendSource? = null          // outgoing: where to read it again from
    var out: OutputStream? = null
    var partFile: File? = null           // incoming: Android keeps half-received files here until they are complete
    var relDirs: List<String> = emptyList()
    var fileName: String = ""
    val answer = CompletableFuture<String>()
    val ack = CompletableFuture<Boolean>()
}

/**
 * File transfer over the encrypted WebSocket (same protocol as the desktop app):
 * file-offer -> file-accept/file-reject -> binary frames [AES-GCM(uint32 tid + data)] -> file-end -> file-ack.
 * Received files go to Downloads/YConnect through MediaStore (no storage permission needed).
 *
 * Resume: file-offer carries a stable `key` of the file; a half-received file is kept (app storage) under that key.
 * When the sender offers it again the receiver answers file-accept {offset} and the sender continues from there.
 * Folders: file-offer also carries `rel` ("Folder/sub/name"); the sub folders are created below Downloads/YConnect.
 */
object Transfers {
    private const val CHUNK = 64 * 1024

    val transfers = MutableStateFlow<List<Transfer>>(emptyList())

    private val history = mutableListOf<TransferState>()
    private val outgoing = ConcurrentHashMap<Long, TransferState>()
    private val incoming = ConcurrentHashMap<Long, TransferState>()
    private var uidCounter = 1
    @Volatile private var lastPublish = 0L
    private val rnd = SecureRandom()

    /* ---------- bookkeeping ---------- */
    private fun nextUid(): Int = synchronized(this) { uidCounter++ }
    private fun newTid(): Long = (rnd.nextInt().toLong() and 0xffffffffL).coerceAtLeast(1L)

    private fun publish(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastPublish < 250) return
        lastPublish = now
        synchronized(history) {
            transfers.value = history
                .map {
                    Transfer(it.uid, it.outgoing, it.peer, it.name, it.size, it.done, it.status,
                        canResume = it.outgoing && it.status == "failed" && it.src != null && Hub.byId[it.peerId]?.isOpen == true)
                }
                .reversed()
        }
    }

    private fun track(t: TransferState) {
        synchronized(history) {
            history.add(t)
            while (history.size > 100) {
                val i = history.indexOfFirst { it.finished }
                if (i < 0) break
                history.removeAt(i)
            }
        }
        publish(true)
    }

    fun clearFinished() {
        synchronized(history) { history.removeAll { it.finished } }
        publish(true)
    }

    private fun partialDir(): File = File(Hub.appCtx.filesDir, "partial").apply { mkdirs() }

    /** Throw away half-received files nobody continued for a week. */
    fun cleanOldPartials() {
        try {
            val now = System.currentTimeMillis()
            partialDir().listFiles()?.forEach { if (now - it.lastModified() > 7L * 86_400_000L) it.delete() }
        } catch (_: Exception) {}
    }

    private fun finish(t: TransferState, status: String) {
        synchronized(t) {
            if (t.finished) return
            t.finished = true
            t.status = status
        }
        if (t.outgoing) outgoing.remove(t.tid) else incoming.remove(t.tid)
        if (!t.outgoing) {
            try { t.out?.close() } catch (_: Exception) {}
            // a dropped connection keeps what has arrived so far so the sender can continue; everything else is thrown away
            val keep = status == "failed" && t.disconnected && t.key.isNotEmpty()
            if (status != "done" && !keep) {
                try { t.partFile?.delete() } catch (_: Exception) {}
                if (t.key.isNotEmpty()) try { File(partialDir(), t.key + ".json").delete() } catch (_: Exception) {}
            }
        }
        t.answer.complete("cancel")
        t.ack.complete(false)
        publish(true)
        val title = when (status) {
            "done" -> if (t.outgoing) "File sent" else "File received"
            "rejected" -> "File declined"
            "cancelled" -> "Transfer cancelled"
            else -> "Transfer failed"
        }
        val extra = when {
            status == "rejected" && t.reason.isNotEmpty() -> " — ${t.reason}"
            status == "failed" && t.disconnected -> " — connection lost, will continue when the device is back"
            else -> ""
        }
        Hub.addLog(if (status == "done") "file" else "warn", title, t.name + extra)
    }

    fun cancel(uid: Int) {
        val t = synchronized(history) { history.firstOrNull { it.uid == uid } } ?: return
        if (t.finished) return
        Hub.sendJson(t.conn, JSONObject().put("type", "file-cancel").put("tid", t.tid))
        finish(t, "cancelled")
    }

    fun onDisconnected(conn: WebSocket) {
        val list = synchronized(history) { history.filter { it.conn === conn && !it.finished } }
        list.forEach { it.disconnected = true; finish(it, "failed") }
    }

    /* ---------- sending ---------- */

    private class Pending(val items: MutableList<SendSource>, @Volatile var at: Long)
    private val resumeQueue = ConcurrentHashMap<String, Pending>()
    private const val QUEUE_TTL = 60L * 60L * 1000L

    /** Same file (id of this phone, uri, size, modified time, folder path) -> same key, so the receiver can recognise it. */
    private fun makeKey(uri: Uri, size: Long, modified: Long, rel: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val raw = md.digest("${Hub.myId}|$uri|$size|$modified|$rel".toByteArray())
        return raw.joinToString("") { "%02x".format(it) }.take(32)
    }

    /**
     * Opens the files right now (share-sheet permission grants disappear when the activity closes)
     * and sends them, one after the other, to every device in [targetIds]. Returns how many files were prepared.
     */
    fun sendUris(ctx: Context, uris: List<Uri>, targetIds: List<String>): Int {
        var started = 0
        for (id in targetIds) {
            if (Hub.byId[id] == null) continue
            val items = mutableListOf<SendSource>()
            for (uri in uris) {
                val d = describe(ctx, uri) ?: continue
                val stream = try { ctx.contentResolver.openInputStream(uri) } catch (e: Exception) { null } ?: continue
                items.add(SendSource(uri, d.name, "", d.size, makeKey(uri, d.size, d.modified, ""), stream))
            }
            if (items.isEmpty()) continue
            started += items.size
            thread(isDaemon = true, name = "yconnect-send") { runItems(id, items) }
        }
        return started
    }

    /** Sends a whole folder picked with the system folder picker (sub folders included). */
    fun sendTree(ctx: Context, treeUri: Uri, targetIds: List<String>) {
        thread(isDaemon = true, name = "yconnect-tree") {
            val items = mutableListOf<SendSource>()
            try {
                val rootId = DocumentsContract.getTreeDocumentId(treeUri)
                var rootName = "Folder"
                try {
                    ctx.contentResolver.query(
                        DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId),
                        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null
                    )?.use { c -> if (c.moveToFirst() && !c.isNull(0)) rootName = c.getString(0) }
                } catch (_: Exception) {}
                walkTree(ctx, treeUri, rootId, safeName(rootName), 0, items)
                Hub.addLog("file", "Sending folder", "$rootName (${items.size} file${if (items.size == 1) "" else "s"})")
            } catch (e: Exception) {
                Hub.addLog("warn", "Cannot read folder", e.message ?: "unknown error")
            }
            if (items.isEmpty()) return@thread
            for (id in targetIds) {
                if (Hub.byId[id] == null) continue
                thread(isDaemon = true, name = "yconnect-send") { runItems(id, items.toList()) }
            }
        }
    }

    private fun walkTree(ctx: Context, tree: Uri, docId: String, rel: String, depth: Int, out: MutableList<SendSource>) {
        if (depth > 40 || out.size >= 20000) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val dirs = mutableListOf<Pair<String, String>>()
        try {
            ctx.contentResolver.query(children, projection, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0) ?: continue
                    val nm = c.getString(1) ?: continue
                    val mime = c.getString(2) ?: ""
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        dirs.add(Pair(id, nm))
                    } else {
                        val size = if (c.isNull(3)) -1L else c.getLong(3)
                        if (size < 0) continue
                        val modified = if (c.isNull(4)) 0L else c.getLong(4)
                        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                        val r = rel + "/" + safeName(nm)
                        out.add(SendSource(uri, safeName(nm), r, size, makeKey(uri, size, modified, r)))
                    }
                    if (out.size >= 20000) return@use
                }
            }
        } catch (_: Exception) {}
        for ((id, nm) in dirs) walkTree(ctx, tree, id, rel + "/" + safeName(nm), depth + 1, out)
    }

    private class Described(val name: String, val size: Long, val modified: Long)

    private fun describe(ctx: Context, uri: Uri): Described? {
        var name: String? = null
        var size = -1L
        var modified = 0L
        try {
            ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    val mi = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    if (ni >= 0) name = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                    if (mi >= 0 && !c.isNull(mi)) modified = c.getLong(mi)
                }
            }
        } catch (_: Exception) {}
        if (size < 0) {
            size = try {
                ctx.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
            } catch (e: Exception) { -1L }
        }
        if (size < 0) {
            Hub.addLog("warn", "Cannot read file", uri.lastPathSegment ?: "unknown")
            return null
        }
        return Described(name ?: uri.lastPathSegment ?: "file", size, modified)
    }

    private fun cancelMsg(tid: Long) = JSONObject().put("type", "file-cancel").put("tid", tid)

    private fun skipFully(s: InputStream, n: Long): Boolean {
        var left = n
        val tmp = ByteArray(64 * 1024)
        while (left > 0) {
            val k = s.skip(left)
            if (k > 0) {
                left -= k
            } else {
                val r = s.read(tmp, 0, minOf(tmp.size.toLong(), left).toInt())
                if (r < 0) return false
                left -= r
            }
        }
        return true
    }

    /** Sends the files in order. If the connection drops, this file and the rest wait for the device to come back. */
    private fun runItems(peerId: String, items: List<SendSource>) {
        for (i in items.indices) {
            val conn = Hub.byId[peerId]
            if (conn == null || !conn.isOpen) {
                queueForResume(peerId, items.subList(i, items.size))
                return
            }
            val r = sendOne(conn, peerId, items[i])
            if (r == "disconnected") {
                queueForResume(peerId, items.subList(i, items.size))
                return
            }
            if (r == "rejected" && items[i].rel.isNotEmpty()) {
                Hub.addLog("warn", "Folder declined", items[i].rel.substringBefore('/') + " (the other device said no)")
                return
            }
        }
    }

    private fun queueForResume(peerId: String, items: List<SendSource>) {
        if (items.isEmpty()) return
        val p = resumeQueue.getOrPut(peerId) { Pending(mutableListOf(), 0L) }
        synchronized(p) {
            for (s in items) if (p.items.none { x -> x.key == s.key }) p.items.add(s)
            p.at = System.currentTimeMillis()
        }
        Hub.addLog("info", "Transfer paused", "${p.items.size} file${if (p.items.size == 1) "" else "s"} will continue when the device reconnects")
        publish(true)
    }

    /** Called by Hub when a device (re)connects: continue what was interrupted. */
    fun onPeerConnected(peerId: String) {
        val p = resumeQueue.remove(peerId) ?: return
        if (System.currentTimeMillis() - p.at > QUEUE_TTL) return
        val items = synchronized(p) { p.items.toList() }
        thread(isDaemon = true, name = "yconnect-resume") {
            try { Thread.sleep(1500) } catch (_: InterruptedException) {}
            Hub.addLog("file", "Resuming transfer", "${items.size} file${if (items.size == 1) "" else "s"}")
            // a failed row of the same file would only be confusing next to the continued one
            synchronized(history) { history.removeAll { it.outgoing && it.peerId == peerId && it.status == "failed" && it.disconnected } }
            publish(true)
            runItems(peerId, items)
        }
    }

    fun dropQueue(peerId: String) { resumeQueue.remove(peerId) }

    /** "Resume" button: continue one failed outgoing file right now. */
    fun resume(uid: Int) {
        val t = synchronized(history) { history.firstOrNull { it.uid == uid } } ?: return
        val src = t.src ?: return
        if (!t.outgoing || t.status != "failed" || Hub.byId[t.peerId]?.isOpen != true) return
        synchronized(history) { history.remove(t) }
        publish(true)
        thread(isDaemon = true, name = "yconnect-resume") { runItems(t.peerId, listOf(src)) }
    }

    private fun outcome(t: TransferState): String = when {
        t.status == "done" -> "done"
        t.disconnected -> "disconnected"
        else -> t.status
    }

    /** Sends one file and waits for the final answer. Returns done | rejected | cancelled | failed | disconnected. */
    private fun sendOne(conn: WebSocket, peerId: String, src: SendSource): String {
        val shown = if (src.rel.isNotEmpty()) src.rel else src.name
        val t = TransferState(nextUid(), newTid(), true, conn, Hub.connInfo[conn]?.name ?: "device", peerId, shown, src.size, src.key)
        t.src = src
        outgoing[t.tid] = t
        track(t)
        var stream: InputStream? = src.first
        src.first = null
        try {
            val offer = JSONObject().put("type", "file-offer").put("tid", t.tid).put("name", src.name).put("size", src.size).put("key", src.key)
            if (src.rel.isNotEmpty()) offer.put("rel", src.rel)
            Hub.sendJson(conn, offer)
            val answer = try { t.answer.get(60, TimeUnit.SECONDS) } catch (e: Exception) { "timeout" }
            if (answer != "accept") {
                if (answer == "timeout") Hub.sendJson(conn, cancelMsg(t.tid))
                finish(t, when (answer) { "reject" -> "rejected"; "cancel" -> "cancelled"; else -> "failed" })
                try { stream?.close() } catch (_: Exception) {}
                return outcome(t)
            }
            val off = if (t.offset in 1..src.size) t.offset else 0L
            if (stream == null) {
                stream = try { Hub.appCtx.contentResolver.openInputStream(src.uri) } catch (e: Exception) { null }
            }
            val input = stream
            if (input == null) {
                Hub.addLog("warn", "Cannot continue", src.name + " can't be opened any more. Send it again.")
                Hub.sendJson(conn, cancelMsg(t.tid))
                finish(t, "failed")
                return "failed"
            }
            if (off > 0 && !skipFully(input, off)) throw IllegalStateException("cannot skip")
            t.done = off
            t.status = "active"
            publish(true)

            val buf = ByteArray(4 + CHUNK)
            buf[0] = (t.tid shr 24).toByte()
            buf[1] = (t.tid shr 16).toByte()
            buf[2] = (t.tid shr 8).toByte()
            buf[3] = t.tid.toByte()
            while (true) {
                if (t.finished || !conn.isOpen) throw IllegalStateException("stopped")
                val n = input.read(buf, 4, CHUNK)
                if (n < 0) break
                // simple back-pressure: wait until the socket has flushed the previous chunk
                while (conn.hasBufferedData()) {
                    if (t.finished || !conn.isOpen) throw IllegalStateException("stopped")
                    LockSupport.parkNanos(200_000)
                }
                conn.send(Crypto.encryptBytes(Hub.key, buf, 0, 4 + n))
                t.done += n
                publish()
            }
            if (t.done != t.size) throw IllegalStateException("file changed while sending")
            Hub.sendJson(conn, JSONObject().put("type", "file-end").put("tid", t.tid))
            val ok = try { t.ack.get(30, TimeUnit.SECONDS) } catch (e: Exception) { false }
            finish(t, if (ok) "done" else "failed")
        } catch (e: Exception) {
            if (!t.finished) {
                Hub.sendJson(conn, cancelMsg(t.tid))
                finish(t, "failed")
            }
        } finally {
            try { stream?.close() } catch (_: Exception) {}
        }
        return outcome(t)
    }

    /* ---------- receiving ---------- */

    fun onMessage(conn: WebSocket, j: JSONObject) {
        val tid = j.optLong("tid", -1)
        when (j.optString("type")) {
            "file-offer" -> onOffer(conn, tid, j)
            "file-end" -> onEnd(conn, tid)
            "file-accept" -> outgoing[tid]?.takeIf { it.conn === conn }?.let {
                it.offset = j.optLong("offset", 0L)
                it.answer.complete("accept")
            }
            "file-reject" -> outgoing[tid]?.takeIf { it.conn === conn }?.let {
                it.reason = j.optString("reason")
                it.answer.complete("reject")
            }
            "file-ack" -> outgoing[tid]?.takeIf { it.conn === conn }?.ack?.complete(j.optBoolean("ok"))
            "file-cancel" -> for (m in listOf(outgoing, incoming)) {
                m[tid]?.takeIf { it.conn === conn }?.let { finish(it, "cancelled") }
            }
        }
    }

    private fun safeName(raw: String): String {
        var s = raw.substringAfterLast('/').substringAfterLast('\\')
        s = s.replace(Regex("[\\u0000-\\u001f<>:\"|?*]"), "_").trimEnd('.', ' ').take(150)
        return if (s.isBlank() || s == "." || s == "..") "file" else s
    }

    /** "A/b/../c" -> [A, c]: every part made safe, no way to climb out of Downloads/YConnect. */
    private fun safeSegments(rel: String, fallbackName: String): List<String> {
        val parts = rel.split('/', '\\').filter { it.isNotBlank() && it != "." && it != ".." }.take(32).map { safeName(it) }
        return if (parts.isEmpty()) listOf(safeName(fallbackName)) else parts
    }

    /** Creates the final file in Downloads/YConnect[/sub/folders] (still hidden from other apps until [markDone]). */
    private fun openSink(name: String, dirs: List<String>): Pair<OutputStream, Uri>? = try {
        val sub = if (dirs.isEmpty()) "" else "/" + dirs.joinToString("/")
        val v = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/YConnect" + sub)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val r = Hub.appCtx.contentResolver
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v)!!
        val os = r.openOutputStream(uri)!!
        Pair(BufferedOutputStream(os, 256 * 1024) as OutputStream, uri)
    } catch (e: Exception) {
        null
    }

    /** Copies the finished partial file into Downloads and makes it visible. */
    private fun moveToDownloads(t: TransferState): Boolean {
        val part = t.partFile ?: return false
        val sink = openSink(t.fileName, t.relDirs) ?: return false
        return try {
            part.inputStream().use { input -> sink.first.use { output -> input.copyTo(output, 256 * 1024) } }
            Hub.appCtx.contentResolver.update(sink.second, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            part.delete()
            if (t.key.isNotEmpty()) File(partialDir(), t.key + ".json").delete()
            true
        } catch (e: Exception) {
            try { Hub.appCtx.contentResolver.delete(sink.second, null, null) } catch (_: Exception) {}
            false
        }
    }

    private val KEY_RE = Regex("[0-9a-f]{16,64}")

    private fun onOffer(conn: WebSocket, tid: Long, j: JSONObject) {
        val size = j.optLong("size", -1)
        val peer = Hub.connInfo[conn]?.name ?: "device"
        fun reject(reason: String) =
            Hub.sendJson(conn, JSONObject().put("type", "file-reject").put("tid", tid).put("reason", reason))
        if (tid < 0 || size < 0 || incoming.containsKey(tid)) { reject("bad offer"); return }
        val name = safeName(j.optString("name"))
        if (!Hub.settings.value.acceptFiles) {
            Hub.addLog("warn", "File declined", "$peer tried to send \"$name\" (receiving is off)")
            reject("receiving is turned off")
            return
        }
        val segs = safeSegments(j.optString("rel", ""), name)
        val fileName = segs.last()
        val relStr = segs.joinToString("/")
        val key = j.optString("key", "").takeIf { KEY_RE.matches(it) } ?: ""

        var offset = 0L
        var partOrNull: File? = null
        var outOrNull: OutputStream? = null
        try {
            val dir = partialDir()
            val p: File
            if (key.isNotEmpty()) {
                p = File(dir, "$key.part")
                val meta = File(dir, "$key.json")
                var metaOk = false
                try {
                    val m = JSONObject(meta.readText())
                    metaOk = m.optLong("size", -1) == size && m.optString("name") == fileName && m.optString("rel") == relStr
                } catch (_: Exception) {}
                val have = if (p.exists()) p.length() else 0L
                if (metaOk && have > 0 && have <= size) offset = have else p.delete()
                meta.writeText(JSONObject().put("size", size).put("name", fileName).put("rel", relStr).toString())
            } else {
                p = File(dir, "tmp-$tid-${System.nanoTime()}.part")
            }
            partOrNull = p
            outOrNull = BufferedOutputStream(FileOutputStream(p, offset > 0), 256 * 1024)
        } catch (e: Exception) {
            reject("cannot write file")
            return
        }
        val part: File = partOrNull ?: run { reject("cannot write file"); return }
        val out: OutputStream = outOrNull ?: run { reject("cannot write file"); return }
        val t = TransferState(nextUid(), tid, false, conn, peer, Hub.connInfo[conn]?.id ?: "", relStr, size, key)
        t.status = "active"
        t.out = out
        t.partFile = part
        t.relDirs = segs.dropLast(1)
        t.fileName = fileName
        t.done = offset
        incoming[tid] = t
        track(t)
        if (offset > 0) Hub.addLog("file", "Continuing file", "$relStr from ${fmtSize(offset)}")
        val accept = JSONObject().put("type", "file-accept").put("tid", tid)
        if (offset > 0) accept.put("offset", offset)
        Hub.sendJson(conn, accept)
    }

    fun onBinary(conn: WebSocket, bytes: ByteBuffer) {
        if (!Hub.connInfo.containsKey(conn)) return
        val raw = ByteArray(bytes.remaining())
        bytes.get(raw)
        val plain = try {
            Crypto.decryptBytes(Hub.key, raw)
        } catch (e: Exception) {
            try { conn.close() } catch (_: Exception) {}
            return
        }
        if (plain.size < 4) return
        val tid = ((plain[0].toLong() and 0xff) shl 24) or ((plain[1].toLong() and 0xff) shl 16) or
            ((plain[2].toLong() and 0xff) shl 8) or (plain[3].toLong() and 0xff)
        val t = incoming[tid] ?: return
        if (t.conn !== conn || t.finished || t.ending) return
        val n = plain.size - 4
        t.done += n
        if (t.done > t.size) {
            Hub.sendJson(conn, cancelMsg(tid))
            finish(t, "failed")
            return
        }
        try {
            t.out?.write(plain, 4, n)
        } catch (e: Exception) {
            Hub.sendJson(conn, cancelMsg(tid))
            finish(t, "failed")
            return
        }
        publish()
    }

    private fun onEnd(conn: WebSocket, tid: Long) {
        val t = incoming[tid]?.takeIf { it.conn === conn && !it.finished && !it.ending } ?: return
        t.ending = true
        // copying a big file into Downloads takes a moment: do it off the network thread
        thread(isDaemon = true, name = "yconnect-recv-end") {
            var ok = try {
                t.out?.flush()
                t.out?.close()
                t.out = null
                t.done == t.size
            } catch (e: Exception) {
                false
            }
            if (ok) ok = moveToDownloads(t)
            Hub.sendJson(conn, JSONObject().put("type", "file-ack").put("tid", tid).put("ok", ok))
            finish(t, if (ok) "done" else "failed")
            if (ok) notifyReceived(t)
        }
    }

    private fun notifyReceived(t: TransferState) {
        try {
            val ctx = Hub.appCtx
            val open = PendingIntent.getActivity(
                ctx, 0,
                Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE
            )
            val n = NotificationCompat.Builder(ctx, "remote")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("File received")
                .setContentText("${t.name} from ${t.peer}")
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(1000 + t.uid, n)
        } catch (_: Exception) {}
    }
}
