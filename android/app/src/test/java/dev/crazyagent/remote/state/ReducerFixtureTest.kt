package dev.crazyagent.remote.state

import dev.crazyagent.remote.data.RemoteJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    @Test fun confirmRequestWaitsThenTheApproveOrANewChatClearsIt() {
        assertMatchesProjection("confirm-request")
        val f = fixture("confirm-request")
        val all = frames(f)
        val checkpoints = f["checkpoints"]!!.jsonObject
        fun checkpoint(name: String) = ChatReducer.fromProjection(checkpoints[name]!!.jsonObject)!!
        fun type(frame: JsonObject) = frame["type"].toString().trim('"')
        fun turn(frame: JsonObject) = frame["turnId"]?.toString()?.trim('"')
        fun upTo(predicate: (JsonObject) -> Boolean) = replay(all.take(all.indexOfFirst(predicate) + 1))

        // The live stream reaches each of the hub's own projections.
        val waiting = upTo { type(it) == "chat.turn" && turn(it) == "turn-8" }
        assertEquals(checkpoint("waiting"), waiting)
        assertTrue(waiting.turn.isWaiting)
        assertEquals(
            ConfirmRequest("turn-8", "Submit the assignment for grading", "Submit for Grading button", "shot-fixture-1", null, waiting.confirm!!.requestedAt),
            waiting.confirm,
        )
        assertNull(waiting.help)
        assertEquals("confirm", waiting.screenshot?.source)
        assertEquals(true, waiting.health.confirmIrreversible)

        // A manual capture while waiting replaces the live view, not the confirm evidence.
        val captured = upTo { type(it) == "remote.screenshot" && it["body"]!!.jsonObject["source"].toString() == "\"manual\"" }
        assertEquals(checkpoint("waitingAfterCapture"), captured)
        assertEquals("shot-fixture-2", captured.screenshot?.id)
        assertEquals("shot-fixture-1", captured.confirm?.screenshotId)
        assertTrue(captured.turn.isWaiting)

        // The approve answer runs as an ordinary turn and shows the decision in plain words; the request is gone at once.
        val approving = upTo { type(it) == "chat.user" && turn(it) == "turn-9" }
        assertNull(approving.confirm)
        assertEquals("running", approving.turn.status)
        assertEquals("Approved: Submit the assignment for grading", (approving.items.last() as ChatItem.User).text)
        val approved = upTo { type(it) == "chat.turn" && turn(it) == "turn-9" }
        assertEquals(checkpoint("afterApprove"), approved)
        assertEquals("idle", approved.turn.status)

        // No capture: the request still waits and says the evidence is missing.
        val blocked = upTo { type(it) == "chat.turn" && turn(it) == "turn-10" }
        assertEquals(checkpoint("waitingNoCapture"), blocked)
        assertNull(blocked.confirm!!.screenshotId)
        assertTrue(blocked.confirm!!.captureError!!.contains("side panel"))

        val end = replay(all)
        assertEquals("session-2", end.sessionId)
        assertNull(end.confirm)
        assertEquals("idle", end.turn.status)
    }

    /**
     * Q10: both malformed-reply endings render on the phone, and the leaked
     * markup the companion streams rides only the transient draft — each ending
     * drops it, so no committed item (and nothing in saved history) carries it.
     */
    @Test fun deadTurnEndingsRenderErrorAndBlockedWithoutMarkup() {
        assertMatchesProjection("dead-turn")
        val f = fixture("dead-turn")
        val all = frames(f)
        val checkpoints = f["checkpoints"]!!.jsonObject
        fun checkpoint(name: String) = ChatReducer.fromProjection(checkpoints[name]!!.jsonObject)!!
        fun type(frame: JsonObject) = frame["type"].toString().trim('"')
        // turnEnded publishes a chat.turn after the ending; the checkpoint includes it.
        fun chatTurnAfter(index: Int): Int {
            for (i in (index + 1) until all.size) if (type(all[i]) == "chat.turn") return i
            return all.size - 1
        }
        val markup = Regex("｜\\s*DSML\\s*｜|\\|\\s*DSML\\s*\\|")
        fun committedMarkup(items: List<ChatItem>): Boolean = items.any { item ->
            when (item) {
                is ChatItem.User -> markup.containsMatchIn(item.text)
                is ChatItem.Assistant -> markup.containsMatchIn(item.text)
                is ChatItem.Done -> markup.containsMatchIn(item.text)
                is ChatItem.Error -> markup.containsMatchIn(item.message)
                is ChatItem.Stopped -> markup.containsMatchIn(item.message.orEmpty())
                is ChatItem.ToolCall -> markup.containsMatchIn(item.args) || markup.containsMatchIn(item.result?.text.orEmpty())
            }
        }
        val errorText = "The model's reply could not be used (MALFORMED_RESPONSE), so nothing was done. Send the request again."
        val blockedText = "BLOCKED: the model sent an empty or malformed reply, so nothing was done on the page. Send the request again."

        // The live stream really does carry the markup as a draft before the ending.
        val errorIndex = all.indexOfFirst { type(it) == "chat.error" }
        val beforeError = replay(all.take(errorIndex))
        assertTrue(markup.containsMatchIn(beforeError.draft?.text.orEmpty()))
        assertTrue(beforeError.turn.isActive)

        // Ending 1: chat.error -> an ERROR note, turn error, draft dropped, no committed markup.
        val afterError = checkpoint("afterError")
        assertEquals(afterError, replay(all.take(chatTurnAfter(errorIndex) + 1)))
        assertEquals("error", afterError.turn.status)
        assertEquals("error", afterError.turn.outcome)
        assertEquals(errorText, afterError.turn.error)
        assertNull(afterError.draft)
        assertEquals(errorText, (afterError.items.last() as ChatItem.Error).message)
        assertFalse(committedMarkup(afterError.items))
        val errorRows = displayRows(afterError.items)
        val errorNote = errorRows.last() as DisplayRow.Note
        assertEquals(NoteKind.ERROR, errorNote.kind)
        assertEquals(errorText, errorNote.text)

        // Ending 2: chat.done BLOCKED -> the answer renders, a DONE note, draft dropped, no markup.
        val doneIndex = all.indexOfFirst { type(it) == "chat.done" }
        val beforeDone = replay(all.take(doneIndex))
        assertTrue(markup.containsMatchIn(beforeDone.draft?.text.orEmpty()))
        val afterBlocked = checkpoint("afterBlocked")
        assertEquals(afterBlocked, replay(all.take(chatTurnAfter(doneIndex) + 1)))
        assertEquals("idle", afterBlocked.turn.status)
        assertEquals("done", afterBlocked.turn.outcome)
        assertNull(afterBlocked.draft)
        val blocked = afterBlocked.items.filterIsInstance<ChatItem.Done>().first()
        assertEquals(blockedText, blocked.text)
        assertEquals(22373L, blocked.usage?.totalTokens)
        assertFalse(committedMarkup(afterBlocked.items))
        val blockedRows = displayRows(afterBlocked.items)
        assertTrue(blockedRows.any { it is DisplayRow.Assistant && it.text == blockedText })
        assertTrue(blockedRows.any { it is DisplayRow.Note && it.kind == NoteKind.DONE })
        // The earlier error note is still in the committed history, clean.
        assertTrue(blockedRows.any { it is DisplayRow.Note && it.kind == NoteKind.ERROR && it.text == errorText })

        // Recovery: an ordinary turn finishes after both dead endings.
        val afterRecovery = checkpoint("afterRecovery")
        assertEquals(afterRecovery, replay(all))
        assertEquals("idle", afterRecovery.turn.status)
        assertNull(afterRecovery.draft)
        assertFalse(committedMarkup(afterRecovery.items))
        assertTrue(displayRows(afterRecovery.items).any { it is DisplayRow.Assistant && it.text == "DONE: all set." })
    }

    @Test fun resyncFramesAreOnlyEverFirst() {
        for (name in listOf("turn-stream", "mid-turn-resync", "lifecycle", "help-request", "confirm-request", "dead-turn")) {
            val all = (fixture(name)["frames"] as JsonArray).map { it.jsonObject["type"].toString() }
            assertEquals("\"remote.resync\"", all.first())
            assertTrue(all.drop(1).none { it == "\"remote.resync\"" })
        }
    }

    /**
     * A3: the recorded frames must actually reach the phone state, not merely be
     * ignored by both the replay and the projection.
     */
    @Test fun regeneratedFixturesCarryPerTurnMeta() {
        val turnFrames = frames(fixture("turn-stream"))
        val doneBody = turnFrames.first { it["type"].toString() == "\"chat.done\"" }["body"]!!.jsonObject
        val reportedUsage = doneBody["usage"]!!.jsonObject
        val done = replay(turnFrames).items.filterIsInstance<ChatItem.Done>().single()
        assertEquals(
            TurnUsage(
                inputTokens = reportedUsage.getValue("inputTokens").jsonPrimitive.long,
                outputTokens = reportedUsage.getValue("outputTokens").jsonPrimitive.long,
                totalTokens = reportedUsage.getValue("totalTokens").jsonPrimitive.long,
            ),
            done.usage,
        )

        val lifecycleFrames = frames(fixture("lifecycle"))
        val beforeNewChat = lifecycleFrames.take(lifecycleFrames.indexOfLast { it["type"].toString() == "\"chat.session\"" })
        val stoppedBody = beforeNewChat.first { it["type"].toString() == "\"chat.stopped\"" }["body"]!!.jsonObject
        val timings = stoppedBody["timings"]!!.jsonObject
        val stopped = replay(beforeNewChat).items.filterIsInstance<ChatItem.Stopped>().last()
        assertEquals(timings.getValue("totalMs").jsonPrimitive.long, stopped.elapsedMs)
        assertEquals(timings.getValue("failedCalls").jsonPrimitive.int, stopped.failedCalls)
        assertEquals(stoppedBody["usage"]!!.jsonObject.getValue("totalTokens").jsonPrimitive.long, stopped.usage?.totalTokens)
    }
}
