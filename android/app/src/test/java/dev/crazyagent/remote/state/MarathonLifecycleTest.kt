package dev.crazyagent.remote.state

import dev.crazyagent.remote.data.RemoteJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * V1-android (MARATHON-V2-PLAN.md §3.2): the alert lifecycle on the phone.
 * Every open notice gets an explicit close frame — `state:'closed'` at turn
 * end ("Turn ended.") and at the next turn start ("A new turn started."),
 * and a dismissed-style frame for the ack path. The reducer treats `closed`
 * exactly like `dismissed`: not actionable, card collapsed, amber cleared.
 * The amber chip never carries into a new turn; `ended-incomplete` stays
 * actionable until dismissed/closed; one open notice at a time.
 *
 * Frames are hand-written to the shape core agreed for task-14; the recorded
 * real-hub fixture is covered separately by [ReducerFixtureTest].
 */
class MarathonLifecycleTest {
    private fun frame(json: String): JsonObject = RemoteJson.parseToJsonElement(json.trimIndent()).jsonObject

    private val resync = frame(
        """
        {"v":1,"instanceId":"i1","seq":5,"type":"remote.resync","body":{"reason":"test",
         "state":{"instanceId":"i1","latestSequence":5,"sessionId":"s1","turn":{"status":"idle"},"messages":[]}}}
        """,
    )

    private val synced: ChatState = ChatReducer.reduce(ChatState(), resync).state

    private fun event(seq: Long, type: String, body: String, turnId: String? = "t1"): JsonObject = frame(
        """
        {"v":1,"instanceId":"i1","seq":$seq,"type":"$type","sessionId":"s1",${if (turnId != null) "\"turnId\":\"$turnId\"," else ""}"body":$body}
        """,
    )

    private fun apply(state: ChatState, seq: Long, type: String, body: String, turnId: String? = "t1"): ChatState {
        val reduction = ChatReducer.reduce(state, event(seq, type, body, turnId))
        assertNull("unexpected resync request", reduction.resync)
        return reduction.state
    }

    private val marathonOn = """
        {"enabled":true,"sessionId":"s1","since":"2026-11-17T12:00:00.000Z","origin":"remote","plan":null,
         "watcher":{"active":false,"checks":0,"lastCheckAt":null,"lastVerdict":null}}
    """

    /** The exact close-frame shape core agreed for V1 (kind info, own id). */
    private fun close(id: String, reason: String, turnId: String = "t1"): String = """
        {"id":"$id","turnId":"$turnId","kind":"info","state":"closed","blocker":null,
         "reason":"$reason","signals":[],"source":"heuristic","at":"2026-11-17T12:05:00.000Z"}
    """

    private fun alert(id: String, kind: String, state: String = "open", reason: String = "A browser call has not returned for several minutes."): String = """
        {"id":"$id","turnId":"t1","kind":"$kind","state":"$state","blocker":${if (state == "open") "\"$kind\"" else "null"},
         "reason":"$reason","signals":[],"source":"heuristic","at":"2026-11-17T12:04:00.000Z"}
    """

    private fun armed(state: ChatState = synced): ChatState = apply(state, 6, "remote.marathon", marathonOn, turnId = null)

    // --- closed at turn end -------------------------------------------------

    @Test fun closedAtTurnEndCollapsesTheAlertExactlyLikeDismissed() {
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w1", "TOOL_HANG"))
        assertTrue(state.watchNotice!!.actionable)
        assertEquals("w1", state.marathon.watch.open?.id)
        assertEquals("May be stuck — review the alert", marathonChipCopy(state.marathon, busy = true, nowMs = 0))

        state = apply(state, 8, "remote.watch", close("w1", "Turn ended."))
        assertNull(state.marathon.watch.open)
        val notice = state.watchNotice!!
        assertEquals("w1", notice.id)
        assertEquals("closed", notice.state)
        assertEquals("Turn ended.", notice.reason)
        assertFalse(notice.actionable)
        // The amber is gone; the chip falls back to its ordinary copy.
        assertEquals("Watching this turn", marathonChipCopy(state.marathon, busy = true, nowMs = 0))
        assertEquals("Every turn uses a live checklist", marathonChipCopy(state.marathon, busy = false, nowMs = 0))

        // A dismissed frame behaves identically (the ack path's shape).
        var viaDismiss = armed()
        viaDismiss = apply(viaDismiss, 7, "remote.watch", alert("w1", "TOOL_HANG"))
        viaDismiss = apply(viaDismiss, 8, "remote.watch", alert("w1", "info", state = "dismissed", reason = "Turn ended."))
        assertEquals(state.marathon, viaDismiss.marathon)
        assertEquals(state.watchNotice!!.actionable, viaDismiss.watchNotice!!.actionable)
        assertNull(viaDismiss.marathon.watch.open)
    }

    @Test fun endedIncompleteSupersedesTheMidTurnAlertAsTheOneOpenNotice() {
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w1", "SILENT_STALL"))
        // Same step at turn end: the alert is closed under its own id…
        state = apply(state, 8, "remote.watch", close("w1", "Turn ended."))
        assertNull(state.marathon.watch.open)
        assertFalse(state.watchNotice!!.actionable)
        // …and ended-incomplete becomes the ONE open notice.
        state = apply(state, 9, "remote.watch", alert("w2", "ended-incomplete", reason = "The turn ended with work still open or blocked."))
        assertEquals("w2", state.marathon.watch.open?.id)
        assertEquals("w2", state.watchNotice!!.id)
        assertTrue(state.watchNotice!!.actionable)
        assertEquals("ended-incomplete", state.watchNotice!!.kind)
        assertEquals("May be stuck — review the alert", marathonChipCopy(state.marathon, busy = false, nowMs = 0))
    }

    // --- closed at the next turn start --------------------------------------

    @Test fun endedIncompleteIsClosedBeforeTheNewTurnsFirstFrame() {
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w2", "ended-incomplete", reason = "The turn ended with work still open or blocked."))
        assertTrue(state.watchNotice!!.actionable)
        // #begin closes the open ended-incomplete BEFORE the new turn's first frame.
        state = apply(state, 8, "remote.watch", close("w2", "A new turn started.", turnId = "t2"))
        assertNull(state.marathon.watch.open)
        assertEquals("A new turn started.", state.watchNotice!!.reason)
        assertFalse(state.watchNotice!!.actionable)
        // The new turn's first frame then drops the collapsed summary: the
        // amber chip never carries into a new turn.
        state = apply(state, 9, "chat.user", """{"text":"continue","origin":"remote","clientMessageId":"c2"}""", turnId = "t2")
        assertNull(state.watchNotice)
        assertNull(state.marathon.watch.open)
        assertTrue(state.turn.isActive)
        assertEquals("Watching this turn", marathonChipCopy(state.marathon, busy = true, nowMs = 0))
    }

    @Test fun anOpenAlertStillHoldsAcrossChatUserUntilItsCloseFrame() {
        // Hub parity: the mirror keeps an open alert until a watch frame clears
        // it. With V1 the close always arrives first; without it (an old
        // companion) the M5 behavior is unchanged.
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(state, 8, "chat.user", """{"text":"steer","origin":"remote","clientMessageId":"c2"}""", turnId = "t2")
        assertEquals("w1", state.marathon.watch.open?.id)
        assertEquals("w1", state.watchNotice?.id)
        state = apply(state, 9, "remote.watch", close("w1", "Turn ended.", turnId = "t2"))
        assertNull(state.marathon.watch.open)
        assertFalse(state.watchNotice!!.actionable)
    }

    // --- the ack path ---------------------------------------------------------

    @Test fun endedIncompleteStaysActionableUntilDismissedOrClosed() {
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w2", "ended-incomplete", reason = "The turn ended with work still open or blocked."))
        // Still actionable after the turn is over (the card offers It's fine).
        state = apply(state, 8, "chat.turn", """{"status":"idle","turnId":"t1","outcome":"done"}""")
        assertTrue(state.watchNotice!!.actionable)
        assertEquals("ended-incomplete", state.marathon.watch.open?.kind)
        // The ack's dismissed-style frame closes it.
        state = apply(state, 9, "remote.watch", alert("w2", "info", state = "dismissed", reason = "Dismissed; this alert kind is snoozed for 15 minutes."))
        assertNull(state.marathon.watch.open)
        assertFalse(state.watchNotice!!.actionable)
        assertEquals("dismissed", state.watchNotice!!.state)
    }

    // --- one open notice, and the existing clears -----------------------------

    @Test fun onlyTheLatestNoticeIsEverShown() {
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(state, 8, "remote.watch", alert("w2", "EXECUTOR_DOWN"))
        assertEquals("w2", state.watchNotice!!.id)
        assertEquals("w2", state.marathon.watch.open?.id)
        state = apply(state, 9, "remote.watch", close("w2", "Turn ended."))
        state = apply(state, 10, "remote.watch", alert("w3", "ended-incomplete", reason = "The turn ended with work still open or blocked."))
        assertEquals("w3", state.watchNotice!!.id)
        assertEquals("w3", state.marathon.watch.open?.id)
        assertTrue(state.watchNotice!!.actionable)
    }

    @Test fun newSessionChatSwitchAndMarathonOffStillClearEverything() {
        fun ended(): ChatState {
            var state = armed()
            state = apply(state, 7, "remote.watch", alert("w2", "ended-incomplete", reason = "The turn ended with work still open or blocked."))
            return state
        }
        // /new (a new session frame).
        val newChat = apply(ended(), 8, "chat.session", """{"sessionId":"s2"}""", turnId = null)
        assertEquals(MarathonState(), newChat.marathon)
        assertNull(newChat.watchNotice)
        // Marathon off.
        val off = apply(ended(), 8, "remote.marathon", """{"enabled":false,"sessionId":null,"since":null,"origin":null,"plan":null,"watcher":{"active":false,"checks":0,"lastCheckAt":null,"lastVerdict":null}}""", turnId = null)
        assertEquals(MarathonState(), off.marathon)
        assertNull(off.watchNotice)
        // A closed notice is cleared by the same paths.
        val closed = apply(apply(ended(), 8, "remote.watch", close("w2", "Turn ended.")), 9, "chat.session", """{"sessionId":"s2"}""", turnId = null)
        assertEquals(MarathonState(), closed.marathon)
        assertNull(closed.watchNotice)
    }

    // --- old-APK compatibility -------------------------------------------------

    @Test fun anyNonOpenStateIsNotActionableForOldAndNewClients() {
        // The M5 (old APK) rule is the same code path: actionable requires
        // state=='open'. closed is just another non-open state, so an old APK
        // collapses the card correctly without knowing the V1 lifecycle.
        for (state in listOf("closed", "dismissed", "recovered", "snoozed", "whatever-comes-next")) {
            var s = armed()
            s = apply(s, 7, "remote.watch", alert("w1", "TOOL_HANG"))
            s = apply(s, 8, "remote.watch", alert("w1", "info", state = state, reason = "Turn ended."))
            assertFalse("state=$state must not be actionable", s.watchNotice!!.actionable)
            assertNull("state=$state must clear the open alert", s.marathon.watch.open)
        }
        // And an unknown envelope type is still ignored entirely (old APK safe).
        val s = armed()
        val next = apply(s, 7, "remote.future_lifecycle", """{"id":"w9"}""")
        assertEquals(s.marathon, next.marathon)
        assertNull(next.watchNotice)
    }

    // --- resync parity -----------------------------------------------------------

    @Test fun aResyncAfterCloseShowsNoAlertAndNoCollapsedHistory() {
        var state = armed()
        state = apply(state, 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(state, 8, "remote.watch", close("w1", "Turn ended."))
        val projection = frame(
            """
            {"instanceId":"i1","latestSequence":8,"sessionId":"s1","turn":{"status":"idle"},"messages":[],
             "marathon":{"enabled":true,"since":"2026-11-17T12:00:00.000Z","plan":null,
              "watch":{"open":null,"lastVerdict":null,"lastCheckAt":null,"checks":0}}}
            """,
        )
        val resynced = ChatReducer.fromProjection(projection)!!
        assertEquals(state.marathon, resynced.marathon)
        assertNull(resynced.marathon.watch.open)
        assertNull(resynced.watchNotice)
        // An open ended-incomplete DOES survive the resync (projection carries it).
        var ended = armed()
        ended = apply(ended, 7, "remote.watch", alert("w2", "ended-incomplete", reason = "The turn ended with work still open or blocked."))
        val endedProjection = frame(
            """
            {"instanceId":"i1","latestSequence":7,"sessionId":"s1","turn":{"status":"idle"},"messages":[],
             "marathon":{"enabled":true,"since":"2026-11-17T12:00:00.000Z","plan":null,
              "watch":{"open":{"id":"w2","kind":"ended-incomplete","at":"2026-11-17T12:04:00.000Z","reason":"The turn ended with work still open or blocked."},
               "lastVerdict":null,"lastCheckAt":null,"checks":0}}}
            """,
        )
        val endedResync = ChatReducer.fromProjection(endedProjection)!!
        assertEquals(ended.marathon, endedResync.marathon)
        assertEquals(ended.watchNotice, endedResync.watchNotice)
        assertTrue(endedResync.watchNotice!!.actionable)
    }

    @Test fun watcherSteerNoteIsMirroredFromLiveWatchAndResync() {
        var state = armed()
        val steeredBody = """
            {"id":"w-steer","turnId":"t1","kind":"stuck","state":"open","blocker":"loop",
             "reason":"Clicking the same submit button with no visible change.","signals":[],
             "source":"both","steer":{"id":"s1","text":"Inspect validation errors instead of clicking Submit."},
             "at":"2026-11-19T23:00:00.000Z"}
        """
        state = apply(state, 7, "remote.watch", steeredBody)
        assertEquals("Inspect validation errors instead of clicking Submit.", state.watchNotice!!.steerText)
        assertEquals("Inspect validation errors instead of clicking Submit.", state.marathon.watch.open?.steerText)

        val projection = frame(
            """
            {"instanceId":"i1","latestSequence":7,"sessionId":"s1","turn":{"status":"running"},"messages":[],
             "marathon":{"enabled":true,"since":"2026-11-17T12:00:00.000Z","plan":null,
              "watch":{"open":{"id":"w-steer","kind":"stuck","at":"2026-11-19T23:00:00.000Z",
               "reason":"Clicking the same submit button with no visible change.",
               "steer":{"id":"s1","text":"Inspect validation errors instead of clicking Submit."}},
               "lastVerdict":"stuck","lastCheckAt":"2026-11-19T23:00:00.000Z","checks":3}}}
            """,
        )
        val resynced = ChatReducer.fromProjection(projection)!!
        assertEquals("Inspect validation errors instead of clicking Submit.", resynced.watchNotice!!.steerText)
        assertEquals("Inspect validation errors instead of clicking Submit.", resynced.marathon.watch.open?.steerText)
    }
}
