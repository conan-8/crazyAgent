package dev.crazyagent.remote.ui

data class SlashCommand(val id: String, val usage: String, val description: String)

const val SLASH_QUERY_MAX_CHARS = 24

val SLASH_COMMANDS = listOf(
    SlashCommand("new", "/new", "Start a new chat"),
    SlashCommand("model", "/model", "View the model for your next turn"),
    SlashCommand("plan", "/plan", "Plan the next turn with a live checklist"),
)

private val slashDraft = Regex("^/([a-z]{0,$SLASH_QUERY_MAX_CHARS})$", RegexOption.IGNORE_CASE)

fun slashQuery(value: String): String? = slashDraft.matchEntire(value)?.groupValues?.get(1)?.lowercase()

fun matchSlashCommands(query: String = ""): List<SlashCommand> {
    val normalized = query.lowercase()
    return SLASH_COMMANDS.filter { it.usage.removePrefix("/").startsWith(normalized) }
}

fun resolveSlashCommand(value: String): SlashCommand? {
    val normalized = value.lowercase()
    return SLASH_COMMANDS.firstOrNull { it.usage == normalized }
}

fun nextSlashIndex(index: Int, length: Int, delta: Int): Int {
    if (length <= 0) return 0
    return ((index + delta) % length + length) % length
}
