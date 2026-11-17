package dev.crazyagent.remote.state

import java.util.Locale

/** What the chat list renders, derived from committed items. */
sealed interface DisplayRow {
    val key: String

    /** [own] marks a prompt sent from a phone: like the panel, the app labels only prompts that came from elsewhere. */
    data class User(override val key: String, val text: String, val from: String, val imageCount: Int, val own: Boolean = false) : DisplayRow
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
                rows += DisplayRow.User(item.key, item.text, originLabel(item.origin), item.imageCount, own = item.origin == "remote")
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

/** The panel's watch-row badge labels (extension/sidepanel/watch-row.js). */
fun watchKindLabel(kind: String): String = when (kind) {
    "SILENT_STALL" -> "Gone quiet"
    "TOOL_HANG" -> "Call not returning"
    "EXECUTOR_DOWN" -> "Executor disconnected"
    "stuck" -> "Stuck"
    "blocked" -> "Blocked"
    "ended-incomplete" -> "Ended incomplete"
    "recovered" -> "Recovered"
    else -> "Watch"
}

/** The watch card's title: an ended turn reads differently from a live alert. */
fun watchTitle(kind: String): String = when (kind) {
    "ended-incomplete" -> "The turn ended incomplete"
    else -> "The agent may be stuck"
}

/**
 * The marathon chip's copy, mirroring the panel's renderMarathonChip: an open
 * alert ambers it; otherwise it says whether the watcher is on this turn or
 * when it last checked. [busy] stands in for the watcher's `active` flag,
 * which the companion computes as enabled && running.
 */
fun marathonChipCopy(marathon: MarathonState, busy: Boolean, nowMs: Long): String = when {
    marathon.watch.open != null -> "May be stuck — review the alert"
    busy -> "Watching this turn"
    marathon.watch.checks > 0 && marathon.watch.lastCheckAt != null -> "Checked ${watchCheckedAgo(marathon.watch.lastCheckAt, nowMs)}"
    else -> "Every turn uses a live checklist"
}

/** "3m ago" style relative label for the last deterministic watch check. */
fun watchCheckedAgo(iso: String?, nowMs: Long): String {
    val at = iso?.let { parseIsoUtc(it) } ?: return "recently"
    val seconds = maxOf(0L, (nowMs - at) / 1000)
    if (seconds < 60) return "${seconds}s ago"
    val minutes = Math.round(seconds / 60.0)
    if (minutes < 60) return "${minutes}m ago"
    return "${Math.round(minutes / 60.0)}h ago"
}

/** Parse the companion's ISO-8601 UTC timestamps; null when unusable. */
private fun parseIsoUtc(value: String): Long? = try {
    java.time.Instant.parse(value).toEpochMilli()
} catch (_: Exception) {
    null
}

/** One-line summary of a plan for the checklist card's header (V6: live or carried). */
fun planSummary(revision: Int, items: List<MarathonPlanItem>): String {
    val open = items.count { it.status == "pending" || it.status == "in_progress" }
    val openText = if (open == 1) "1 open" else "$open open"
    return "Revision $revision · $openText of ${items.size}"
}

fun planSummary(plan: MarathonPlan): String = planSummary(plan.revision, plan.items)

/** One-line description of what the running turn is doing. */
fun activityLine(turn: TurnInfo, phase: Phase): String? = when {
    turn.status == "stopping" -> "Stopping…"
    turn.status != "running" -> null
    phase.status == "capturing" -> "Looking at the page…"
    phase.status == "tool" && phase.tool != null -> "Using ${phase.tool}…"
    phase.status == "tool" -> "Using a tool…"
    else -> "Thinking…"
}
