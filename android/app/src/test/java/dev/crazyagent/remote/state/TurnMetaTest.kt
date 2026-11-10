package dev.crazyagent.remote.state

import dev.crazyagent.remote.data.RemoteJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A3 phone side: per-turn token usage and stopped-turn meta.
 *
 * Frames here are hand-written on purpose; the recorded protocol fixtures are
 * covered separately by [ReducerFixtureTest].
 */
class TurnMetaTest {
    private fun frame(json: String): JsonObject = RemoteJson.parseToJsonElement(json.trimIndent()).jsonObject

    private val resync = frame(
        """
        {"v":1,"instanceId":"i1","seq":5,"type":"remote.resync","body":{"reason":"test",
         "state":{"instanceId":"i1","latestSequence":5,"sessionId":"s1","turn":{"status":"idle"},"messages":[]}}}
        """,
    )

    private val synced: ChatState = ChatReducer.reduce(ChatState(), resync).state

    private fun event(seq: Long, type: String, body: String): JsonObject = frame(
        """
        {"v":1,"instanceId":"i1","seq":$seq,"type":"$type","sessionId":"s1","turnId":"t1","body":$body}
        """,
    )

    private fun apply(state: ChatState = synced, seq: Long = 6, type: String, body: String): ChatState {
        val reduction = ChatReducer.reduce(state, event(seq, type, body))
        assertNull("unexpected resync request", reduction.resync)
        return reduction.state
    }

    private fun notes(items: List<ChatItem>): List<DisplayRow.Note> =
        displayRows(items).filterIsInstance<DisplayRow.Note>()

    // --- parsing ------------------------------------------------------------

    @Test fun doneFrameParsesReportedUsage() {
        val state = apply(
            type = "chat.done",
            body = """{"text":"Done.","label":"done","model":"fixture/model",
                      "usage":{"inputTokens":120,"outputTokens":30,"totalTokens":150,"cacheReadTokens":40}}""",
        )
        val done = state.items.single() as ChatItem.Done
        assertEquals("Done.", done.text)
        assertEquals("fixture/model", done.model)
        assertEquals(TurnUsage(inputTokens = 120, outputTokens = 30, totalTokens = 150), done.usage)
    }

    @Test fun doneFrameWithoutUsageStaysNull() {
        // Old frames have no usage at all, and a newer frame may carry null/foreign shapes.
        assertNull((apply(type = "chat.done", body = """{"text":"Done.","model":"m"}""").items.single() as ChatItem.Done).usage)
        assertNull((apply(type = "chat.done", body = """{"text":"Done.","usage":null}""").items.single() as ChatItem.Done).usage)
        assertNull((apply(type = "chat.done", body = """{"text":"Done.","usage":"lots"}""").items.single() as ChatItem.Done).usage)
        assertNull(
            (apply(type = "chat.done", body = """{"text":"Done.","usage":{"totalTokens":"150"}}""").items.single() as ChatItem.Done).usage,
        )
    }

    @Test fun doneUsageKeepsReportedZeros() {
        // The display decides that a zero count is not worth a note; the state keeps what arrived.
        val done = apply(
            type = "chat.done",
            body = """{"text":"Done.","usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}""",
        ).items.single() as ChatItem.Done
        assertEquals(TurnUsage(inputTokens = 0, outputTokens = 0, totalTokens = 0), done.usage)
    }

    @Test fun stoppedFrameParsesTimingsAndPartialUsage() {
        val state = apply(
            type = "chat.stopped",
            body = """{"reason":"user","message":"Stopped by user.",
                      "timings":{"totalMs":12345,"autoCaptureMs":0,"toolCalls":3,"failedCalls":2},
                      "usage":{"inputTokens":15,"outputTokens":3,"totalTokens":18}}""",
        )
        val stopped = state.items.single() as ChatItem.Stopped
        assertEquals("user", stopped.reason)
        assertEquals("Stopped by user.", stopped.message)
        assertEquals(12_345L, stopped.elapsedMs)
        assertEquals(2, stopped.failedCalls)
        assertEquals(TurnUsage(inputTokens = 15, outputTokens = 3, totalTokens = 18), stopped.usage)
    }

    @Test fun stoppedFrameWithoutMetaStaysNull() {
        val stopped = apply(type = "chat.stopped", body = """{"reason":"user","message":"Stopped."}""")
            .items.single() as ChatItem.Stopped
        assertNull(stopped.elapsedMs)
        assertNull(stopped.failedCalls)
        assertNull(stopped.usage)
    }

    @Test fun stoppedTimingsWithForeignTypesStayNull() {
        val stopped = apply(
            type = "chat.stopped",
            body = """{"message":"Stopped.","timings":{"totalMs":"slow","failedCalls":"two"},"usage":[1,2,3]}""",
        ).items.single() as ChatItem.Stopped
        assertNull(stopped.elapsedMs)
        assertNull(stopped.failedCalls)
        assertNull(stopped.usage)
    }

    // --- display ------------------------------------------------------------

    @Test fun doneNoteAddsTokensOnlyWhenReported() {
        val notes = notes(
            listOf(
                ChatItem.Done("1", "t1", "Done.", "fixture/model", TurnUsage(inputTokens = 12_000, outputTokens = 345, totalTokens = 12_345)),
                ChatItem.Done("2", "t2", "Done.", "fixture/model"),
                ChatItem.Done("3", "t3", "Done.", "fixture/model", TurnUsage(inputTokens = 0, outputTokens = 0, totalTokens = 0)),
            ),
        )
        assertEquals("Done · fixture/model · 12,345 tok", notes[0].text)
        assertEquals("Done · fixture/model", notes[1].text)
        assertEquals("Done · fixture/model", notes[2].text)
        assertEquals(NoteKind.DONE, notes[0].kind)
    }

    @Test fun doneNoteFallsBackToInputPlusOutputTokens() {
        val notes = notes(
            listOf(
                ChatItem.Done("1", "t1", "Done.", "m", TurnUsage(inputTokens = 100, outputTokens = 23)),
                ChatItem.Done("2", "t2", "Done.", "m", TurnUsage(inputTokens = 100, outputTokens = 23, totalTokens = 0)),
            ),
        )
        assertEquals("Done · m · 123 tok", notes[0].text)
        assertEquals("Done · m · 123 tok", notes[1].text)
    }

    @Test fun stoppedNoteAppendsDurationFailuresAndTokens() {
        val notes = notes(
            listOf(
                ChatItem.Stopped(
                    "1", "t1", "user", "Stopped by user.",
                    TurnUsage(inputTokens = 15, outputTokens = 3, totalTokens = 18), elapsedMs = 12_345, failedCalls = 2,
                ),
                ChatItem.Stopped(
                    "2", "t2", "user", "Stopped by user.",
                    TurnUsage(inputTokens = 1_200, outputTokens = 34, totalTokens = 1_234), elapsedMs = 850, failedCalls = 0,
                ),
                ChatItem.Stopped("3", "t3", "user", null),
            ),
        )
        assertEquals("Stopped by user. · 12.3s · 2 failed · 18 tok", notes[0].text)
        // A reported zero is not a failure worth showing, and 850 ms stays in milliseconds.
        assertEquals("Stopped by user. · 850ms · 1,234 tok", notes[1].text)
        assertEquals("Stopped", notes[2].text)
        assertTrue(notes.none { '\n' in it.text })
    }

    @Test fun stoppedNoteUsesShortMinuteFormForLongTurns() {
        val note = notes(listOf(ChatItem.Stopped("1", "t1", "user", "Stopped.", elapsedMs = 192_000))).single()
        assertEquals("Stopped. · 3m 12s", note.text)
    }
}