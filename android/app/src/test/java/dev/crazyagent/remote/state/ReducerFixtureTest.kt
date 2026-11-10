package dev.crazyagent.remote.state

import dev.crazyagent.remote.data.RemoteJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Replays frames recorded from the real companion `RemoteHub`
 * (`scripts/remote-protocol-fixtures.mjs`) and requires the reducer to reach
 * the hub's own final `/state` projection.
 */
class ReducerFixtureTest {
    private fun fixture(name: String): JsonObject {
        val text = javaClass.classLoader!!.getResource("remote-protocol/$name.json")!!.readText()
        return RemoteJson.parseToJsonElement(text).jsonObject
    }

    private fun frames(f: JsonObject): List<JsonObject> = f["frames"]!!.jsonArray.map { it.jsonObject }

    private fun replay(frames: List<JsonObject>, start: ChatState = ChatState()): ChatState =
        frames.fold(start) { state, frame ->
            val reduction = ChatReducer.reduce(state, frame)
            assertNull("unexpected resync request at ${frame["seq"]}", reduction.resync)
            reduction.state
        }

    private fun assertMatchesProjection(name: String) {
        val f = fixture(name)
        val streamed = replay(frames(f))
        val expected = ChatReducer.fromProjection(f["final"]!!.jsonObject)!!
        assertEquals(expected, streamed)
        assertEquals(0, streamed.malformedFrames)
        // Replaying every frame again (a duplicate replay) changes nothing.
        assertEquals(streamed, replay(frames(f).drop(1), streamed))
    }

    @Test fun turnStreamMatchesHubProjection() {
        assertMatchesProjection("turn-stream")
        val state = replay(frames(fixture("turn-stream")))
        val types = state.items.map { it::class.simpleName }
        assertEquals(listOf("User", "Assistant", "ToolCall", "Done"), types)
        val tool = state.items[2] as ChatItem.ToolCall
        assertEquals("browser_click", tool.name)
        assertEquals(ToolResult(true, "clicked \"Cart\""), tool.result)
        assertEquals("idle", state.turn.status)
        assertEquals("done", state.turn.outcome)
        assertEquals(1, (state.items[0] as ChatItem.User).imageCount)
        assertNull(state.draft)
        assertEquals(Screenshot("shot-fixture-1", 1, 1, "image/png", "2026-11-06T12:00:17.000Z", "tool"), state.screenshot)
    }

    @Test fun turnStreamShowsDraftUntilCommit() {
        val all = frames(fixture("turn-stream"))
        val commitIndex = all.indexOfFirst { it["type"].toString() == "\"chat.assistant\"" }
        val beforeCommit = replay(all.take(commitIndex))
        assertEquals("I'll open the cart.", beforeCommit.draft?.text)
        assertEquals("The user wants the cart.", beforeCommit.draft?.reasoning)
        assertEquals(listOf(DraftTool("call-1", "browser_click", "{\"label\":3}")), beforeCommit.draft?.tools)
        val afterCommit = replay(all.take(commitIndex + 1))
        assertNull(afterCommit.draft)
        assertTrue(afterCommit.items.last() is ChatItem.Assistant)
    }

    @Test fun midTurnResyncCarriesTheAggregatedDraft() {
        assertMatchesProjection("mid-turn-resync")
        val first = replay(frames(fixture("mid-turn-resync")).take(1))
        assertEquals("running", first.turn.status)
        assertEquals("The page lists ", first.draft?.text)
        assertEquals("{\"max", first.draft?.tools?.single()?.args)
        val second = replay(frames(fixture("mid-turn-resync")).take(3))
        assertEquals("The page lists three products.", second.draft?.text)
        assertEquals("{\"max_chars\":4000}", second.draft?.tools?.single()?.args)
    }

    @Test fun lifecycleStopErrorHealthAndNewSession() {
        assertMatchesProjection("lifecycle")
        val f = fixture("lifecycle")
        val all = frames(f)
        val sessionIndex = all.indexOfLast { it["type"].toString() == "\"chat.session\"" }
        val beforeNew = replay(all.take(sessionIndex))
        val afterError = ChatReducer.fromProjection(f["checkpoints"]!!.jsonObject["afterError"]!!.jsonObject)!!
        assertEquals(afterError, beforeNew)
        assertEquals("error", beforeNew.turn.status)
        assertTrue(beforeNew.items.any { it is ChatItem.Stopped })
        assertTrue(beforeNew.items.any { it is ChatItem.Error })
        assertEquals(true, beforeNew.health.uiConnected)
        assertEquals("shot-fixture-1", beforeNew.screenshot?.id)

        val end = replay(all)
        assertEquals("session-2", end.sessionId)
        assertTrue(end.items.isEmpty())
        assertNull(end.screenshot)
    }

    @Test fun helpRequestWaitsThenTheReplyOrANewChatClearsIt() {
        assertMatchesProjection("help-request")
        val f = fixture("help-request")
        val all = frames(f)
        val checkpoints = f["checkpoints"]!!.jsonObject
        fun checkpoint(name: String) = ChatReducer.fromProjection(checkpoints[name]!!.jsonObject)!!
        fun type(frame: JsonObject) = frame["type"].toString().trim('"')
        fun turn(frame: JsonObject) = frame["turnId"]?.toString()?.trim('"')
        fun upTo(predicate: (JsonObject) -> Boolean) = replay(all.take(all.indexOfFirst(predicate) + 1))

        // The live stream reaches each of the hub's own projections.
        val waiting = upTo { type(it) == "chat.turn" && turn(it) == "turn-5" }
        assertEquals(checkpoint("waiting"), waiting)
        assertTrue(waiting.turn.isWaiting)
        assertEquals(HelpRequest("turn-5", "login", "Sign in to the mail site, then tell me to continue.", "shot-fixture-1", null, waiting.help!!.requestedAt), waiting.help)
        assertEquals("help", waiting.screenshot?.source)

        // A manual capture while waiting replaces the live view, not the help evidence.
        val captured = upTo { type(it) == "remote.screenshot" && it["body"]!!.jsonObject["source"].toString() == "\"manual\"" }
        assertEquals(checkpoint("waitingAfterCapture"), captured)
        assertEquals("shot-fixture-2", captured.screenshot?.id)
        assertEquals("shot-fixture-1", captured.help?.screenshotId)
        assertTrue(captured.turn.isWaiting)

        // The reply runs as an ordinary turn and the request is gone at once.
        val replying = upTo { type(it) == "chat.user" && turn(it) == "turn-6" }
        assertNull(replying.help)
        assertEquals("running", replying.turn.status)
        val replied = upTo { type(it) == "chat.turn" && turn(it) == "turn-6" }
        assertEquals(checkpoint("afterReply"), replied)
        assertEquals("idle", replied.turn.status)

        // No capture: the request still waits and says the evidence is missing.
        val blocked = upTo { type(it) == "chat.turn" && turn(it) == "turn-7" }
        assertEquals(checkpoint("waitingNoCapture"), blocked)
        assertNull(blocked.help!!.screenshotId)
        assertTrue(blocked.help!!.captureError!!.contains("side panel"))

        val end = replay(all)
        assertEquals("session-2", end.sessionId)
        assertNull(end.help)
        assertEquals("idle", end.turn.status)
    }

    @Test fun resyncFramesAreOnlyEverFirst() {
        for (name in listOf("turn-stream", "mid-turn-resync", "lifecycle", "help-request")) {
            val all = (fixture(name)["frames"] as JsonArray).map { it.jsonObject["type"].toString() }
            assertEquals("\"remote.resync\"", all.first())
            assertTrue(all.drop(1).none { it == "\"remote.resync\"" })
        }
    }
}
