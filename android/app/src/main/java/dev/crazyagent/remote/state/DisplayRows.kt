package dev.crazyagent.remote.state

import java.util.Locale

/** What the chat list renders, derived from committed items. */
sealed interface DisplayRow {
    val key: String

    data class User(override val key: String, val text: String, val from: String, val imageCount: Int) : DisplayRow
    data class Assistant(override val key: String, val text: String) : DisplayRow
    data class Tool(override val key: String, val name: String, val args: String, val result: ToolResult?) : DisplayRow
    data class Note(override val key: String, val text: String, val kind: NoteKind) : DisplayRow
}

enum class NoteKind { DONE, STOPPED, ERROR }

fun originLabel(origin: String?): String = when (origin) {
    "remote" -> "You · phone"
    "ui" -> "Desktop panel"
    null, "" -> "Prompt"
    else -> "From $origin"
}

/**
 * `chat.done` repeats the final answer that usually already arrived as
 * `chat.assistant`; show its text only when it adds something.
 */
fun displayRows(items: List<ChatItem>): List<DisplayRow> {
    val rows = ArrayList<DisplayRow>(items.size)
    var lastAssistant: Pair<String?, String>? = null
    for (item in items) {
        when (item) {
            is ChatItem.User -> {
                rows += DisplayRow.User(item.key, item.text, originLabel(item.origin), item.imageCount)
                lastAssistant = null
            }
            is ChatItem.Assistant -> {
                rows += DisplayRow.Assistant(item.key, item.text)
                lastAssistant = item.turnId to item.text.trim()
            }
            is ChatItem.ToolCall -> rows += DisplayRow.Tool(item.key, item.name ?: "tool", item.args, item.result)
            is ChatItem.Done -> {
                val text = item.text.trim()
                val repeated = lastAssistant?.let { (turn, last) -> (turn == null || turn == item.turnId) && last == text } ?: false
                if (text.isNotEmpty() && !repeated) rows += DisplayRow.Assistant("${item.key}:text", item.text)
                val note = listOfNotNull("Done", item.model, tokenText(item.usage)).joinToString(" · ")
                rows += DisplayRow.Note(item.key, note, NoteKind.DONE)
            }
            is ChatItem.Stopped -> {
                val parts = mutableListOf(item.message?.takeIf { it.isNotBlank() } ?: "Stopped")
                durationText(item.elapsedMs)?.let(parts::add)
                failedText(item.failedCalls)?.let(parts::add)
                tokenText(item.usage)?.let(parts::add)
                rows += DisplayRow.Note(item.key, parts.joinToString(" · "), NoteKind.STOPPED)
            }
            is ChatItem.Error -> rows += DisplayRow.Note(item.key, item.message, NoteKind.ERROR)
        }
    }
    return rows
}

/**
 * Compact per-turn token count, matching the side panel's turn divider: prefer
 * `totalTokens`, otherwise input+output, and never show a zero count.
 */
private fun tokenText(usage: TurnUsage?): String? {
    val tokens = tokenCount(usage) ?: return null
    return "${String.format(Locale.US, "%,d", tokens)} tok"
}

private fun tokenCount(usage: TurnUsage?): Long? {
    if (usage == null) return null
    val total = usage.totalTokens
    if (total != null && total > 0) return total
    val sum = (usage.inputTokens ?: 0L) + (usage.outputTokens ?: 0L)
    return sum.takeIf { it > 0 }
}

/** `850ms` under a second, `12.3s` under a minute, then `3m 12s` (panel parity). */
private fun durationText(ms: Long?): String? {
    if (ms == null || ms < 0) return null
    if (ms < 1_000) return "${maxOf(1L, ms)}ms"
    if (ms < 60_000) return String.format(Locale.US, "%.1fs", ms / 1000.0)
    val minutes = ms / 60_000
    val seconds = Math.round((ms % 60_000) / 1000.0)
    return String.format(Locale.US, "%dm %02ds", minutes, seconds)
}

/** Only failures are worth a note; `0 failed` is noise on a stopped turn. */
private fun failedText(failedCalls: Int?): String? =
    failedCalls?.takeIf { it > 0 }?.let { "$it failed" }

/** Short heading for a help request; unknown categories read as a generic request. */
fun helpTitle(category: String?): String = when (category) {
    "login" -> "Sign-in needed"
    "captcha" -> "CAPTCHA or verification needed"
    "permission" -> "Permission needed"
    "ambiguous" -> "Your decision needed"
    "error" -> "Blocked by an error"
    else -> "Your help needed"
}

/** One-line description of what the running turn is doing. */
fun activityLine(turn: TurnInfo, phase: Phase): String? = when {
    turn.status == "stopping" -> "Stopping…"
    turn.status != "running" -> null
    phase.status == "capturing" -> "Looking at the page…"
    phase.status == "tool" && phase.tool != null -> "Using ${phase.tool}…"
    phase.status == "tool" -> "Using a tool…"
    else -> "Thinking…"
}
