package dev.crazyagent.remote.state

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
                rows += DisplayRow.Note(item.key, listOfNotNull("Done", item.model).joinToString(" · "), NoteKind.DONE)
            }
            is ChatItem.Stopped -> rows += DisplayRow.Note(item.key, item.message?.takeIf { it.isNotBlank() } ?: "Stopped", NoteKind.STOPPED)
            is ChatItem.Error -> rows += DisplayRow.Note(item.key, item.message, NoteKind.ERROR)
        }
    }
    return rows
}

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
