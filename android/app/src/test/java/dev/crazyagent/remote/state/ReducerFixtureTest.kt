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

    /**
     * M5: the marathon switch, watch notices (hard alert, judge stuck/blocked,
     * recovery, ended-incomplete, dismissal), and the carried plan checklist,
     * all recorded from the real RemoteHub. The live stream must reach each of
     * the hub's own checkpoint projections, and the final new-chat reset.
     */
    @Test fun marathonWatchMatchesHubProjection() {
        assertMatchesProjection("marathon-watch")
        val f = fixture("marathon-watch")
        val all = frames(f)
        val checkpoints = f["checkpoints"]!!.jsonObject
        fun checkpoint(name: String) = ChatReducer.fromProjection(checkpoints[name]!!.jsonObject)!!
        fun type(frame: JsonObject) = frame["type"].toString().trim('"')
        fun body(frame: JsonObject) = frame["body"]!!.jsonObject
        fun field(frame: JsonObject, key: String) = body(frame)[key].toString().trim('"')
        fun upTo(predicate: (JsonObject) -> Boolean) = replay(all.take(all.indexOfFirst(predicate) + 1))

        // The switch mirrors remote.marathon; the armed turn's prompt carries marathon:true.
        val on = upTo { type(it) == "remote.marathon" }
        assertTrue(on.marathon.enabled)
        assertEquals("2026-11-06T12:00:01.000Z", on.marathon.since)

        // A hard deterministic alert opens the card and the projection alert.
        val alert = upTo { type(it) == "remote.watch" && field(it, "kind") == "TOOL_HANG" }
        assertEquals(checkpoint("afterAlert"), alert)
        assertTrue(alert.watchNotice!!.actionable)
        assertEquals("TOOL_HANG", alert.marathon.watch.open?.kind)
        assertEquals(3, alert.marathon.watch.checks)

        // M4 judge verdicts ride the same envelope and are actionable too.
        val judge = upTo { type(it) == "remote.watch" && field(it, "kind") == "stuck" }
        assertEquals(checkpoint("afterJudge"), judge)
        assertTrue(judge.watchNotice!!.actionable)
        assertEquals("loop", body(all.first { type(it) == "remote.watch" && field(it, "kind") == "stuck" })["blocker"].toString().trim('"'))
        val blocked = upTo { type(it) == "remote.watch" && field(it, "kind") == "blocked" }
        assertEquals(checkpoint("afterBlocked"), blocked)
        assertTrue(blocked.watchNotice!!.actionable)

        // Recovery collapses the notice and clears the open alert.
        val recovered = upTo { type(it) == "remote.watch" && field(it, "state") == "recovered" }
        assertNull(recovered.marathon.watch.open)
        assertEquals("recovered", recovered.watchNotice?.state)
        assertFalse(recovered.watchNotice!!.actionable)

        // The carried plan arrives with remote.marathon — the phone's first checklist.
        val carried = upTo { type(it) == "remote.marathon" && body(it)["plan"] is JsonObject }
        val plan = carried.marathon.plan!!
        assertEquals(2, plan.revision)
        assertEquals(listOf("completed", "in_progress", "pending"), plan.items.map { it.status })
        assertEquals(2, plan.openCount)
        assertEquals("turn-14", plan.turnId)

        // chat.done carries both mode flags and the additive watch summary; the
        // ended-incomplete notice opens the card again after the turn is over.
        val doneBody = body(all.first { type(it) == "chat.done" })
        assertEquals("true", doneBody["marathon"].toString())
        assertEquals("true", doneBody["planMode"].toString())
        assertEquals("unfinished", doneBody["planOutcome"].toString().trim('"'))
        assertEquals(6, doneBody["watch"]!!.jsonObject["checks"]!!.jsonPrimitive.int)
        val ended = upTo { type(it) == "chat.turn" }
        assertEquals(checkpoint("afterEnded"), ended)
        assertEquals("idle", ended.turn.status)
        assertEquals("done", ended.turn.outcome)
        assertTrue(ended.watchNotice!!.actionable)
        assertEquals("ended-incomplete", ended.marathon.watch.open?.kind)
        assertEquals(2, ended.marathon.plan?.revision)

        // "It's fine" dismisses the alert; a new chat resets switch, plan, watch.
        val dismissed = upTo { type(it) == "remote.watch" && field(it, "state") == "dismissed" }
        assertNull(dismissed.marathon.watch.open)
        assertFalse(dismissed.watchNotice!!.actionable)
        val end = replay(all)
        assertEquals("session-2", end.sessionId)
        assertEquals(MarathonState(), end.marathon)
        assertNull(end.watchNotice)
        assertTrue(end.items.isEmpty())
    }

    /**
     * V1 (task-15): the alert lifecycle recorded from the real RemoteHub with
     * core's V1 lifecycle code — a mid-turn alert closed at turn end,
     * ended-incomplete superseding it as the one open notice, the
     * ended-incomplete closed BEFORE the next turn's first frame, a second
     * ended-incomplete dismissed through the ack path, and the new-chat reset.
     */
    @Test fun marathonWatchLifecycleMatchesHubProjection() {
        assertMatchesProjection("marathon-watch-lifecycle")
        val f = fixture("marathon-watch-lifecycle")
        val all = frames(f)
        val checkpoints = f["checkpoints"]!!.jsonObject
        fun checkpoint(name: String) = ChatReducer.fromProjection(checkpoints[name]!!.jsonObject)!!
        fun type(frame: JsonObject) = frame["type"].toString().trim('"')
        fun body(frame: JsonObject) = frame["body"]!!.jsonObject
        fun field(frame: JsonObject, key: String) = body(frame)[key].toString().trim('"')
        fun upTo(predicate: (JsonObject) -> Boolean) = replay(all.take(all.indexOfFirst(predicate) + 1))

        // The mid-turn alert opens the card.
        val alert = upTo { type(it) == "remote.watch" && field(it, "kind") == "TOOL_HANG" }
        assertEquals(checkpoint("afterAlert"), alert)
        assertTrue(alert.watchNotice!!.actionable)

        // Turn end closes it under its OWN id; ended-incomplete supersedes it.
        val closedAlert = upTo { type(it) == "remote.watch" && field(it, "state") == "closed" }
        assertEquals("watch-life-1", closedAlert.watchNotice!!.id)
        assertEquals("Turn ended.", closedAlert.watchNotice!!.reason)
        assertNull(closedAlert.marathon.watch.open)
        assertFalse(closedAlert.watchNotice!!.actionable)
        val superseded = upTo { type(it) == "chat.turn" && field(it, "turnId") == "turn-15" }
        assertEquals(checkpoint("afterSupersede"), superseded)
        assertEquals("watch-life-2", superseded.marathon.watch.open?.id)
        assertEquals("ended-incomplete", superseded.watchNotice!!.kind)
        assertTrue(superseded.watchNotice!!.actionable)

        // The next turn start closes the ended-incomplete BEFORE chat.user:
        // the amber chip never carries into a new turn.
        val closedIdx = all.indexOfFirst { type(it) == "remote.watch" && field(it, "reason") == "A new turn started." }
        val userIdx = all.indexOfFirst { type(it) == "chat.user" && field(it, "clientMessageId") == "client-turn-16" }
        assertTrue("close frame must precede the new turn's first frame", closedIdx in 0 until userIdx)
        // startTurn emits chat.user then chat.status thinking; the hub
        // checkpoint sits after both.
        assertEquals("chat.status", type(all[userIdx + 1]))
        val nextStart = replay(all.take(userIdx + 2))
        assertEquals(checkpoint("afterNextTurnStart"), nextStart)
        assertNull(nextStart.marathon.watch.open)
        assertNull(nextStart.watchNotice)
        assertTrue(nextStart.turn.isActive)

        // The second turn's ended-incomplete stays actionable until the ack.
        val secondEnded = upTo { type(it) == "chat.turn" && field(it, "turnId") == "turn-16" }
        assertEquals(checkpoint("afterSecondEnded"), secondEnded)
        assertEquals("watch-life-3", secondEnded.marathon.watch.open?.id)
        assertTrue(secondEnded.watchNotice!!.actionable)
        val dismissed = upTo { type(it) == "remote.watch" && field(it, "state") == "dismissed" }
        assertEquals("watch-life-3", dismissed.watchNotice!!.id)
        assertEquals("Dismissed.", dismissed.watchNotice!!.reason)
        assertNull(dismissed.marathon.watch.open)
        assertFalse(dismissed.watchNotice!!.actionable)

        // A new chat resets the switch and every watch state.
        val end = replay(all)
        assertEquals("session-2", end.sessionId)
        assertEquals(MarathonState(), end.marathon)
        assertNull(end.watchNotice)
        assertTrue(end.items.isEmpty())
    }

    /**
     * V6 (task-20): the live checklist recorded from the real RemoteHub —
     * remote.plan mid-turn, a malformed activity dropped (no envelope),
     * awaitingUser, the turn-end handoff to the carried plan, and the reset.
     */
    @Test fun marathonLivePlanMatchesHubProjection() {
        assertMatchesProjection("marathon-live-plan")
        val f = fixture("marathon-live-plan")
        val all = frames(f)
        val checkpoints = f["checkpoints"]!!.jsonObject
        fun checkpoint(name: String) = ChatReducer.fromProjection(checkpoints[name]!!.jsonObject)!!
        fun type(frame: JsonObject) = frame["type"].toString().trim('"')
        fun body(frame: JsonObject) = frame["body"]!!.jsonObject
        fun upTo(predicate: (JsonObject) -> Boolean) = replay(all.take(all.indexOfFirst(predicate) + 1))

        // The first live plan arrives mid-turn; the malformed activity after it
        // published nothing (three remote.plan envelopes for four activities).
        assertEquals(3, all.count { type(it) == "remote.plan" })
        val first = upTo { type(it) == "remote.plan" }
        assertEquals(checkpoint("livePlan1"), first)
        assertEquals(1, first.turn.plan!!.revision)
        assertEquals(3, first.turn.plan!!.openCount)
        assertTrue(first.turn.isActive)
        assertNull(first.marathon.plan)

        // An accepted revision replaces the list live.
        val plans = all.filter { type(it) == "remote.plan" }
        val second = replay(all.take(all.indexOf(plans[1]) + 1))
        assertEquals(checkpoint("livePlan2"), second)
        assertEquals(2, second.turn.plan!!.revision)
        assertEquals("completed", second.turn.plan!!.items[0].status)
        assertEquals(2, second.turn.plan!!.openCount)

        // awaitingUser rides along without a revision change.
        val awaiting = replay(all.take(all.indexOf(plans[2]) + 1))
        assertEquals(checkpoint("awaiting"), awaiting)
        assertTrue(awaiting.turn.plan!!.awaitingUser)
        assertEquals(2, awaiting.turn.plan!!.revision)

        // Turn end: the live plan clears and remote.marathon carries the list.
        val ended = upTo { type(it) == "remote.marathon" && body(it)["plan"] is JsonObject }
        assertEquals(checkpoint("afterTurnEnd"), ended)
        assertNull(ended.turn.plan)
        assertEquals("idle", ended.turn.status)
        assertEquals(2, ended.marathon.plan!!.revision)
        assertEquals(2, ended.marathon.plan!!.openCount)
        assertEquals("turn-17", ended.marathon.plan!!.turnId)

        // A new chat resets everything.
        val end = replay(all)
        assertEquals("session-2", end.sessionId)
        assertNull(end.turn.plan)
        assertEquals(MarathonState(), end.marathon)
    }

    @Test fun resyncFramesAreOnlyEverFirst() {
        for (name in listOf("turn-stream", "mid-turn-resync", "lifecycle", "help-request", "confirm-request", "dead-turn", "marathon-watch", "marathon-watch-lifecycle", "marathon-live-plan")) {
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
