package dev.crazyagent.remote.state

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReducerTest {
    private fun resync(instance: String = "i1", seq: Long = 5): JsonObject = buildJsonObject {
        put("v", 1); put("instanceId", instance); put("seq", seq); put("type", "remote.resync")
        putJsonObject("body") {
            put("reason", "no-instance")
            putJsonObject("state") {
                put("instanceId", instance); put("latestSequence", seq); put("sessionId", "s1")
                putJsonObject("turn") { put("status", "idle") }
                put("messages", buildJsonArray {})
            }
        }
    }

    private fun event(seq: Long, type: String, instance: String = "i1", turnId: String? = "t1", body: JsonObject.() -> JsonObject = { this }): JsonObject = buildJsonObject {
        put("v", 1); put("instanceId", instance); put("seq", seq); put("type", type); put("sessionId", "s1")
        if (turnId != null) put("turnId", turnId)
        put("body", JsonObject(emptyMap()).body())
    }

    private fun body(vararg pairs: Pair<String, Any?>): JsonObject.() -> JsonObject = {
        buildJsonObject {
            for ((k, v) in pairs) when (v) {
                is String -> put(k, v)
                is Number -> put(k, v)
                is Boolean -> put(k, v)
                null -> put(k, null as String?)
            }
        }
    }

    private val synced = ChatReducer.reduce(ChatState(), resync()).state

    @Test fun eventsBeforeAnyResyncRequestOne() {
        assertEquals(ResyncReason.GAP, ChatReducer.reduce(ChatState(), event(1, "chat.user")).resync)
    }

    @Test fun duplicatesAreIgnoredAndGapsRequestResync() {
        val next = ChatReducer.reduce(synced, event(6, "chat.user", body = body("text" to "hi", "clientMessageId" to "c1"))).state
        assertEquals(6, next.lastSeq)
        assertEquals(next, ChatReducer.reduce(next, event(6, "chat.user", body = body("text" to "again"))).state)
        assertEquals(next, ChatReducer.reduce(next, event(3, "chat.assistant", body = body("text" to "old"))).state)
        val gap = ChatReducer.reduce(next, event(8, "chat.assistant", body = body("text" to "x")))
        assertEquals(ResyncReason.GAP, gap.resync)
        assertEquals(next, gap.state)
    }

    @Test fun anotherInstanceRequestsResync() {
        assertEquals(ResyncReason.INSTANCE_CHANGED, ChatReducer.reduce(synced, event(6, "chat.user", instance = "i2")).resync)
    }

    @Test fun malformedFramesAreCountedNotApplied() {
        val noType = ChatReducer.reduce(synced, buildJsonObject { put("seq", 6) })
        assertEquals(1, noType.state.malformedFrames)
        assertEquals(5, noType.state.lastSeq)
        val noSeq = ChatReducer.reduce(synced, buildJsonObject { put("type", "chat.user"); put("instanceId", "i1") })
        assertEquals(1, noSeq.state.malformedFrames)
        val badResync = ChatReducer.reduce(synced, buildJsonObject { put("type", "remote.resync") })
        assertEquals(synced.copy(malformedFrames = 1), badResync.state)
    }

    @Test fun unknownTypesAdvanceTheSequence() {
        val next = ChatReducer.reduce(synced, event(6, "remote.future_thing"))
        assertNull(next.resync)
        assertEquals(6, next.state.lastSeq)
        assertEquals(synced.items, next.state.items)
    }

    @Test fun draftDeltasAppendOnceAndGapsResync() {
        var state = ChatReducer.reduce(synced, event(6, "chat.user", body = body("text" to "go"))).state
        state = ChatReducer.reduce(state, event(7, "chat.draft", body = body("streamId" to "t1:s1", "channel" to "text", "offset" to 0, "delta" to "Hel"))).state
        state = ChatReducer.reduce(state, event(8, "chat.draft", body = body("streamId" to "t1:s1", "channel" to "text", "offset" to 3, "delta" to "lo"))).state
        assertEquals("Hello", state.draft?.text)
        // A stale delta already covered by the aggregate is ignored.
        state = ChatReducer.reduce(state, event(9, "chat.draft", body = body("streamId" to "t1:s1", "channel" to "text", "offset" to 0, "delta" to "He"))).state
        assertEquals("Hello", state.draft?.text)
        val gap = ChatReducer.reduce(state, event(10, "chat.draft", body = body("streamId" to "t1:s1", "channel" to "text", "offset" to 9, "delta" to "!")))
        assertEquals(ResyncReason.DRAFT_GAP, gap.resync)
        // A commit naming the stream replaces the draft.
        val committed = ChatReducer.reduce(state, event(10, "chat.assistant", body = body("text" to "Hello", "replacesStreamId" to "t1:s1"))).state
        assertNull(committed.draft)
        assertEquals("Hello", (committed.items.last() as ChatItem.Assistant).text)
    }

    @Test fun commitForAnotherStreamKeepsTheDraft() {
        var state = ChatReducer.reduce(synced, event(6, "chat.draft", body = body("streamId" to "t1:s2", "channel" to "text", "offset" to 0, "delta" to "x"))).state
        state = ChatReducer.reduce(state, event(7, "chat.assistant", body = body("text" to "y", "replacesStreamId" to "t1:s1"))).state
        assertEquals("x", state.draft?.text)
    }

    @Test fun toolResultsAttachToTheirCallOrStandAlone() {
        var state = ChatReducer.reduce(synced, event(6, "chat.tool_call", body = body("callId" to "c1", "name" to "browser_click", "args" to "{}"))).state
        state = ChatReducer.reduce(state, event(7, "chat.tool_result", body = body("callId" to "c1", "ok" to false, "text" to "missed"))).state
        assertEquals(1, state.items.size)
        assertEquals(ToolResult(false, "missed"), (state.items[0] as ChatItem.ToolCall).result)
        state = ChatReducer.reduce(state, event(8, "chat.tool_result", body = body("callId" to "c9", "ok" to true, "text" to "?"))).state
        assertEquals(2, state.items.size)
    }

    @Test fun userPromptMarksTheTurnRunningAndTurnEndIsAuthoritative() {
        var state = ChatReducer.reduce(synced, event(6, "chat.user", body = body("text" to "go", "origin" to "ui"))).state
        assertTrue(state.turn.isActive)
        assertEquals("ui", state.turn.origin)
        state = ChatReducer.reduce(state, event(7, "chat.stopping")).state
        assertEquals("stopping", state.turn.status)
        state = ChatReducer.reduce(state, event(8, "chat.turn", body = body("status" to "idle", "turnId" to "t1", "outcome" to "stopped"))).state
        assertEquals(TurnInfo(status = "idle", turnId = "t1", outcome = "stopped"), state.turn)
    }

    @Test fun doneTextIsShownOnlyWhenItAddsSomething() {
        val items = listOf(
            ChatItem.User("1", "t1", "q", "remote", "c", 0),
            ChatItem.Assistant("2", "t1", "Answer"),
            ChatItem.Done("3", "t1", "Answer", "m"),
            ChatItem.User("4", "t2", "q2", "ui", null, 2),
            ChatItem.Done("5", "t2", "Fresh final", null),
        )
        val rows = displayRows(items)
        assertEquals(
            listOf("User", "Assistant", "Note", "User", "Assistant", "Note"),
            rows.map { it::class.simpleName },
        )
        assertEquals("You · phone", (rows[0] as DisplayRow.User).from)
        assertEquals("Desktop panel", (rows[3] as DisplayRow.User).from)
        assertEquals("Fresh final", (rows[4] as DisplayRow.Assistant).text)
    }

    @Test fun activityLineFollowsTurnAndPhase() {
        assertNull(activityLine(TurnInfo(status = "idle"), Phase()))
        assertEquals("Thinking…", activityLine(TurnInfo(status = "running"), Phase("thinking")))
        assertEquals("Using browser_click…", activityLine(TurnInfo(status = "running"), Phase("tool", "browser_click")))
        assertEquals("Stopping…", activityLine(TurnInfo(status = "stopping"), Phase("tool", "x")))
    }

    @Test fun contextUsageFollowsHealthAndResetsForANewSession() {
        var state = ChatReducer.reduce(synced, event(6, "remote.health", body = body(
            "dsh" to "ready",
            "model" to "m",
            "contextWindow" to 128_000,
            "contextTokens" to 12_345,
        ))).state
        assertEquals(128_000L, state.health.contextWindow)
        assertEquals(12_345L, state.health.contextTokens)
        state = ChatReducer.reduce(state, event(7, "chat.session", body = body("sessionId" to "s2"))).state
        assertEquals(128_000L, state.health.contextWindow)
        assertNull(state.health.contextTokens)
    }

    @Test fun aResumedSessionWithSavedMessagesAsksForAResync() {
        val restored = ChatReducer.reduce(synced, event(6, "chat.session", turnId = null, body = body("sessionId" to "s0", "resumed" to true, "restoredMessages" to 4)))
        assertEquals(ResyncReason.SESSION_RESTORED, restored.resync)
        assertEquals("s0", restored.state.sessionId)
        assertTrue(restored.state.items.isEmpty())
        // Nothing to fetch for an empty saved chat, and a plain new session never resyncs.
        assertNull(ChatReducer.reduce(synced, event(6, "chat.session", turnId = null, body = body("sessionId" to "s0", "resumed" to true, "restoredMessages" to 0))).resync)
        assertNull(ChatReducer.reduce(synced, event(6, "chat.session", turnId = null, body = body("sessionId" to "s2"))).resync)
    }
}
