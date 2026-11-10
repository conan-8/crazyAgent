package dev.crazyagent.remote.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SlashCommandsTest {
    @Test fun slashDraftsAreSingleLeadingTokens() {
        assertEquals("", slashQuery("/"))
        assertEquals("n", slashQuery("/n"))
        assertEquals("model", slashQuery("/MODEL"))
        assertEquals("plan", slashQuery("/Plan"))
        for (value in listOf("", "new", "/new chat", "/new ", "/new\n", "/usr/local/bin", " /new", "check /new", "/new!", "/new-extra", "/${"n".repeat(SLASH_QUERY_MAX_CHARS + 1)}")) {
            assertNull(value, slashQuery(value))
        }
    }

    @Test fun commandsFilterInDisplayOrder() {
        assertEquals(listOf("new", "model", "plan"), matchSlashCommands().map { it.id })
        assertEquals(listOf("new"), matchSlashCommands("n").map { it.id })
        assertEquals(listOf("model"), matchSlashCommands("M").map { it.id })
        assertEquals(listOf("plan"), matchSlashCommands("PL").map { it.id })
        assertEquals(emptyList<SlashCommand>(), matchSlashCommands("x"))
    }

    @Test fun onlyExactCommandsResolve() {
        assertEquals("new", resolveSlashCommand("/NEW")?.id)
        assertEquals("model", resolveSlashCommand("/model")?.id)
        assertEquals("plan", resolveSlashCommand("/PLAN")?.id)
        for (value in listOf("", "/", "/n", "/new ", " /new", "/new chat", "/model\n", "/models", "/plan ", "/plan task", "/plans")) {
            assertNull(value, resolveSlashCommand(value))
        }
    }

    @Test fun selectionWraps() {
        assertEquals(1, nextSlashIndex(0, 3, 1))
        assertEquals(0, nextSlashIndex(2, 3, 1))
        assertEquals(2, nextSlashIndex(0, 3, -1))
        assertEquals(0, nextSlashIndex(0, 0, 1))
    }
}
