package dev.crazyagent.remote.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SlashCommandsTest {
    @Test fun slashDraftsAreSingleLeadingTokens() {
        assertEquals("", slashQuery("/"))
        assertEquals("n", slashQuery("/n"))
        assertEquals("model", slashQuery("/MODEL"))
        assertEquals("marathon", slashQuery("/Marathon"))
        assertEquals("plan", slashQuery("/Plan"))
        for (value in listOf("", "new", "/new chat", "/new ", "/new\n", "/usr/local/bin", " /new", "check /new", "/new!", "/new-extra", "/${"n".repeat(SLASH_QUERY_MAX_CHARS + 1)}")) {
            assertNull(value, slashQuery(value))
        }
    }

    @Test fun commandsFilterInDisplayOrder() {
        assertEquals(listOf("new", "model", "marathon"), matchSlashCommands().map { it.id })
        assertEquals(listOf("new"), matchSlashCommands("n").map { it.id })
        assertEquals(listOf("model", "marathon"), matchSlashCommands("M").map { it.id })
        assertEquals(listOf("marathon"), matchSlashCommands("MAR").map { it.id })
        assertEquals(emptyList<SlashCommand>(), matchSlashCommands("x"))
        // M5: /plan is an unlisted alias — no prefix filter ever shows it.
        assertEquals(emptyList<SlashCommand>(), matchSlashCommands("plan"))
        assertEquals(emptyList<SlashCommand>(), matchSlashCommands("p"))
    }

    @Test fun onlyExactCommandsResolve() {
        assertEquals("new", resolveSlashCommand("/NEW")?.id)
        assertEquals("model", resolveSlashCommand("/model")?.id)
        assertEquals("marathon", resolveSlashCommand("/MARATHON")?.id)
        for (value in listOf("", "/", "/n", "/new ", " /new", "/new chat", "/model\n", "/models", "/marathon ", "/marathon task", "/marathons")) {
            assertNull(value, resolveSlashCommand(value))
        }
    }

    @Test fun planResolvesToMarathonWithoutBeingListed() {
        // The legacy one-release alias: exact /plan runs the marathon command.
        assertEquals("marathon", resolveSlashCommand("/plan")?.id)
        assertEquals("marathon", resolveSlashCommand("/PLAN")?.id)
        assertEquals("/marathon", resolveSlashCommand("/plan")?.usage)
        for (value in listOf("/plan ", "/plan task", "/plans", "/pl")) {
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
