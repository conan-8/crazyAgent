package dev.crazyagent.remote.ui

data class SlashCommand(val id: String, val usage: String, val description: String)

const val SLASH_QUERY_MAX_CHARS = 24

val SLASH_COMMANDS = listOf(
    SlashCommand("new", "/new", "Start a new chat"),
    SlashCommand("model", "/model", "View the model for your next turn"),
    SlashCommand("marathon", "/marathon", "Plan every turn with a live checklist"),
)

/**
 * Unlisted aliases kept for one release (MARATHON-PLAN.md §3.6): an exact
 * `/plan` still runs the marathon command, but the palette never lists it.
 */
private val SLASH_ALIASES = mapOf("/plan" to "marathon")

private val slashDraft = Regex("^/([a-z]{0,$SLASH_QUERY_MAX_CHARS})$", RegexOption.IGNORE_CASE)

fun slashQuery(value: String): String? = slashDraft.matchEntire(value)?.groupValues?.get(1)?.lowercase()

fun matchSlashCommands(query: String = ""): List<SlashCommand> {
    val normalized = query.lowercase()
    return SLASH_COMMANDS.filter { it.usage.removePrefix("/").startsWith(normalized) }
}

fun resolveSlashCommand(value: String): SlashCommand? {
    val normalized = value.lowercase()
    SLASH_COMMANDS.firstOrNull { it.usage == normalized }?.let { return it }
    val alias = SLASH_ALIASES[normalized] ?: return null
    return SLASH_COMMANDS.firstOrNull { it.id == alias }
}

fun nextSlashIndex(index: Int, length: Int, delta: Int): Int {
    if (length <= 0) return 0
    return ((index + delta) % length + length) % length
}
