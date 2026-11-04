// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
package com.yokeswaran.yconnect

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private fun platformLabel(p: String) = when (p) {
    "windows" -> "Windows"
    "linux" -> "Linux"
    else -> p.replaceFirstChar { it.uppercase() }
}

/** Run a command on a connected Linux / Windows computer, with saved and recent commands. */
@Composable
fun RunPage(pad: PaddingValues) {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val peers by Hub.peers.collectAsState()
    val saved by RemoteCommands.saved.collectAsState()
    val recent by RemoteCommands.recent.collectAsState()
    val runs by RemoteCommands.runs.collectAsState()

    val computers = peers.filter { it.platform != "android" }
    var targetId by rememberSaveable { mutableStateOf("") }
    val target = computers.firstOrNull { it.id == targetId } ?: computers.firstOrNull()

    var command by rememberSaveable { mutableStateOf("") }
    var shell by rememberSaveable { mutableStateOf("default") }
    var timeout by rememberSaveable { mutableIntStateOf(30) }
    var toSave by remember { mutableStateOf<SavedCommand?>(null) }

    // current form as a SavedCommand (id/label are unused until it is saved)
    fun formEntry() = SavedCommand("", "", command.trim(), shell)

    fun fill(c: SavedCommand) { command = c.text; shell = c.shell }

    fun go(c: SavedCommand) {
        val t = target
        when {
            t == null -> toast(ctx, "No computer connected")
            c.text.isBlank() -> toast(ctx, "Type something first")
            else -> RemoteCommands.run(t, c.text, c.shell, timeout)
        }
    }

    Page("Run", "Run commands on your computers.", pad) {
        Card("Computer") {
            if (computers.isEmpty()) {
                Text("No Linux or Windows computer is connected", fontWeight = FontWeight.Bold)
                Dim("Pair this phone with a computer on the Devices tab first. Commands only go to computers, never to other phones.")
            } else {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    computers.forEach { c ->
                        FilterChip(
                            selected = target?.id == c.id, onClick = { targetId = c.id },
                            label = { Text("${c.name} · ${platformLabel(c.platform)}") }
                        )
                    }
                }
                Dim("On the computer, open Y Connect > Sync > Remote control and switch on \"Allow commands from phone\". It is off until you do.")
            }
        }

        Card("Command") {
            val win = target?.platform == "windows"
            OutlinedTextField(
                command, { command = it }, label = { Text("Command") },
                placeholder = { Text(if (win) "dir %USERPROFILE%\\Downloads" else "ls -la ~/Downloads") },
                minLines = 2, maxLines = 6,
                textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth()
            )
            if (win) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = shell != "powershell", onClick = { shell = "default" }, label = { Text("Command Prompt") })
                FilterChip(selected = shell == "powershell", onClick = { shell = "powershell" }, label = { Text("PowerShell") })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Dim("Stop after")
                listOf(30, 60, 120).forEach { s ->
                    FilterChip(selected = timeout == s, onClick = { timeout = s }, label = { Text("${s}s") })
                }
            }
            Dim("Runs as your normal user, starting in the home folder. Anything with sudo, su, runas or \"run as administrator\" is refused, and so is anything that deletes files (rm, del, rmdir, Remove-Item, find -delete). Programs that wait for typing never finish; use options that end by themselves.")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { go(formEntry()) }, enabled = target != null && command.isNotBlank()) { Text("Run") }
                OutlinedButton(onClick = { toSave = formEntry() }, enabled = command.isNotBlank()) { Text("Save") }
            }
        }

        Card("Saved") {
            if (saved.isEmpty()) Dim("Commands you use often live here. Run something, then tap Save (or the Save next to it under Recent).")
            saved.forEach { c ->
                Column(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.label, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Dim(if (c.shell == "powershell") "powershell" else "command")
                    }
                    Text(c.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = cs.onSurfaceVariant, maxLines = 2)
                    Row {
                        TextButton(onClick = { fill(c) }) { Text("Edit") }
                        TextButton(onClick = { go(c) }, enabled = target != null) { Text("Run") }
                        TextButton(onClick = { RemoteCommands.delete(c.id) }) { Text("Delete", color = cs.error) }
                    }
                }
            }
        }

        if (recent.isNotEmpty()) Card("Recent") {
            recent.forEach { c ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { fill(c) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        c.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                        maxLines = 1, modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { toSave = c }) { Text("Save") }
                }
            }
            TextButton(onClick = { RemoteCommands.clearRecent() }) { Text("Clear recent") }
        }

        Card("Results") {
            if (runs.isEmpty()) Dim("Nothing run yet. If something fails, this tells you why it happened and how to fix it.")
            runs.forEach { RunResult(it) }
            if (runs.any { it.status != "running" }) TextButton(onClick = { RemoteCommands.clearRuns() }) { Text("Clear results") }
        }
    }

    toSave?.let { c ->
        SaveDialog(c, onDismiss = { toSave = null }) { name ->
            RemoteCommands.save(name, c.text, c.shell)
            toSave = null
            toast(ctx, "Saved")
        }
    }
}

@Composable
private fun SaveDialog(c: SavedCommand, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var name by remember(c) { mutableStateOf(c.text.take(24)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Save for later") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(40) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text(c.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 3)
            }
        },
        confirmButton = { Button(onClick = { onSave(name) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun OutputBox(title: String, text: String, isError: Boolean) {
    val cs = MaterialTheme.colorScheme
    Dim(title)
    Column(
        Modifier.fillMaxWidth().heightIn(max = 220.dp).clip(RoundedCornerShape(8.dp))
            .background(cs.surfaceContainer).verticalScroll(rememberScrollState()).padding(8.dp)
    ) {
        SelectionContainer {
            Text(text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = if (isError) cs.error else cs.onSurface)
        }
    }
}

@Composable
private fun RunResult(e: RunEntry) {
    val cs = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val running = e.status == "running"
    val ok = e.status == "done"
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surface)
            .border(1.dp, cs.outlineVariant, RoundedCornerShape(12.dp)).animateContentSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (running) "Running…" else if (ok) "✓ Done" else "✗ Failed",
                color = if (ok) OkGreen else if (running) cs.primary else cs.error,
                fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f)
            )
            Dim(e.peer + if (!running && e.ms > 0) " · ${e.ms} ms" else "")
        }
        Text("$ " + e.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        if (running) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            TextButton(onClick = { RemoteCommands.cancel(e.rid) }) { Text("Cancel") }
        }
        if (e.stdout.isNotEmpty()) OutputBox("Output", e.stdout, false)
        if (e.stderr.isNotEmpty()) OutputBox("Error output", e.stderr, true)
        if (e.stdout.isNotEmpty() || e.stderr.isNotEmpty()) TextButton(onClick = { copyText(ctx, (e.stdout + "\n" + e.stderr).trim()) }) { Text("Copy output") }
        if (e.truncated) Dim("Output was cut after 48 KB.")
        if (!running && !ok && e.code > 0) Dim("Exit code ${e.code}")
        e.error?.let { err ->
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.errorContainer).padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text("Why this happened", color = cs.onErrorContainer, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Text(err.why, color = cs.onErrorContainer, fontSize = 13.sp)
                Spacer(Modifier.size(2.dp))
                Text("How to fix it", color = cs.onErrorContainer, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                Text(err.fix, color = cs.onErrorContainer, fontSize = 13.sp)
            }
        }
    }
}
