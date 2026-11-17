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
 * M5 phone side: the companion-owned marathon switch, the carried plan
 * checklist, and watch notices (hard signals, M4 judge stuck/blocked,
 * ended-incomplete, recovery collapse).
 *
 * Frames here are hand-written on purpose; the recorded protocol fixtures are
 * covered separately by [ReducerFixtureTest].
 */
class MarathonReducerTest {
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
        {"enabled":true,"sessionId":"s1","since":"2026-11-16T12:00:00.000Z","origin":"remote","plan":null,
         "watcher":{"active":false,"checks":0,"lastCheckAt":null,"lastVerdict":null}}
    """

    private val plan = """
        {"revision":2,"items":[{"content":"Fill the form","status":"completed"},{"content":"Submit it","status":"in_progress"},{"content":"Verify","status":"pending"}],
         "updatedAt":"2026-11-16T12:05:00.000Z","turnId":"t1"}
    """

    private fun alert(id: String, kind: String, state: String = "open", source: String = "heuristic", blocker: String? = kind, reason: String = "A browser call has not returned for several minutes."): String = """
        {"id":"$id","turnId":"t1","kind":"$kind","state":"$state","blocker":${if (blocker == null) "null" else "\"$blocker\""},
         "reason":"$reason","signals":[{"kind":"$kind","level":"hard","detail":"browser_wait_for unanswered for 250s"}],
         "source":"$source","at":"2026-11-16T12:04:00.000Z"}
    """

    // --- the switch ---------------------------------------------------------

    @Test fun remoteMarathonMirrorsTheSwitchAndWatcherCounters() {
        var state = apply(synced, 6, "remote.marathon", marathonOn, turnId = null)
        assertEquals(MarathonState(enabled = true, since = "2026-11-16T12:00:00.000Z"), state.marathon)
        state = apply(
            state, 7, "remote.marathon",
            """
            {"enabled":true,"sessionId":"s1","since":"2026-11-16T12:00:00.000Z","origin":"remote","plan":$plan,
             "watcher":{"active":true,"checks":3,"lastCheckAt":"2026-11-16T12:03:00.000Z","lastVerdict":null}}
            """,
            turnId = null,
        )
        assertTrue(state.marathon.enabled)
        assertEquals(3, state.marathon.watch.checks)
        assertEquals("2026-11-16T12:03:00.000Z", state.marathon.watch.lastCheckAt)
        assertNull(state.marathon.watch.lastVerdict)
        val carried = state.marathon.plan!!
        assertEquals(2, carried.revision)
        assertEquals(3, carried.items.size)
        assertEquals(2, carried.openCount)
        assertEquals("Submit it", carried.items[1].content)
        assertEquals("in_progress", carried.items[1].status)
    }

    @Test fun marathonOffClearsPlanWatchAndAnyNotice() {
        var state = apply(synced, 6, "remote.marathon", marathonOn, turnId = null)
        state = apply(state, 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(
            state, 8, "remote.marathon",
            """{"enabled":false,"sessionId":null,"since":null,"origin":null,"plan":null,"watcher":{"active":false,"checks":0,"lastCheckAt":null,"lastVerdict":null}}""",
            turnId = null,
        )
        assertEquals(MarathonState(), state.marathon)
        assertNull(state.watchNotice)
        // A non-boolean enabled fails closed to off, never a guessed state.
        val foreign = apply(synced, 6, "remote.marathon", """{"enabled":"yes","plan":$plan}""", turnId = null)
        assertEquals(MarathonState(), foreign.marathon)
    }

    @Test fun carriedPlanValidationFailsClosed() {
        fun planState(planJson: String): MarathonPlan? = apply(
            synced, 6, "remote.marathon",
            """{"enabled":true,"sessionId":"s1","since":"2026-11-16T12:00:00.000Z","origin":"remote","plan":$planJson,"watcher":{"active":false,"checks":0,"lastCheckAt":null,"lastVerdict":null}}""",
            turnId = null,
        ).marathon.plan

        assertEquals(2, planState(plan)!!.revision)
        // Bad revision, missing markers, empty/oversized lists, blank or duplicate
        // content, and unknown statuses are all null — never a partial plan.
        assertNull(planState("""{"revision":-1,"items":[{"content":"x","status":"pending"}],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("""{"revision":1.5,"items":[{"content":"x","status":"pending"}],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("""{"revision":1,"items":[{"content":"x","status":"pending"}],"turnId":"t1"}"""))
        assertNull(planState("""{"revision":1,"items":[{"content":"x","status":"pending"}],"updatedAt":"u"}"""))
        assertNull(planState("""{"revision":1,"items":[],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("""{"revision":1,"items":[{"content":"  ","status":"pending"}],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("""{"revision":1,"items":[{"content":"x","status":"done"}],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("""{"revision":1,"items":[{"content":"x","status":"pending"},{"content":"x","status":"completed"}],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("""{"revision":1,"items":[{"content":"x"}],"updatedAt":"u","turnId":"t1"}"""))
        assertNull(planState("null"))
        assertNull(planState("\"a plan\""))
        val fortyOne = (1..41).joinToString(",") { """{"content":"item $it","status":"pending"}""" }
        assertNull(planState("""{"revision":1,"items":[$fortyOne],"updatedAt":"u","turnId":"t1"}"""))
        // All four provider statuses are accepted.
        val statuses = planState("""{"revision":0,"items":[{"content":"a","status":"pending"},{"content":"b","status":"in_progress"},{"content":"c","status":"completed"},{"content":"d","status":"blocked"}],"updatedAt":"u","turnId":"t1"}""")!!
        assertEquals(listOf("pending", "in_progress", "completed", "blocked"), statuses.items.map { it.status })
        assertEquals(2, statuses.openCount)
    }

    // --- watch notices ------------------------------------------------------

    @Test fun hardAlertOpensTheCardAndTheProjectionAlert() {
        val state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "TOOL_HANG"))
        val notice = state.watchNotice!!
        assertEquals("w1", notice.id)
        assertEquals("TOOL_HANG", notice.kind)
        assertEquals("open", notice.state)
        assertTrue(notice.actionable)
        assertEquals(WatchOpen("w1", "TOOL_HANG", "2026-11-16T12:04:00.000Z", "A browser call has not returned for several minutes."), state.marathon.watch.open)
        // The chip ambers while the alert is open.
        assertEquals("May be stuck — review the alert", marathonChipCopy(state.marathon, busy = true, nowMs = 0))
    }

    @Test fun judgeStuckAndBlockedVerdictsAreActionable() {
        // M4 judge alerts pass through the hub unchanged: kind is the verdict
        // state, source watcher/both, blocker a sub-reason, reason ≤240 chars.
        for ((kind, source) in listOf("stuck" to "watcher", "blocked" to "both")) {
            val state = apply(
                apply(synced, 6, "remote.marathon", marathonOn, turnId = null),
                7, "remote.watch",
                alert("w-$kind", kind, source = source, blocker = "loop", reason = "The same click repeats with no page change."),
            )
            val notice = state.watchNotice!!
            assertTrue("$kind must be actionable", notice.actionable)
            assertEquals(kind, state.marathon.watch.open?.kind)
            assertEquals("The same click repeats with no page change.", notice.reason)
            assertEquals("Stuck", watchKindLabel("stuck"))
            assertEquals("Blocked", watchKindLabel("blocked"))
            assertEquals("The agent may be stuck", watchTitle(kind))
        }
    }

    @Test fun recoveryCollapsesTheCardAndClearsTheOpenAlert() {
        var state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "SILENT_STALL"))
        state = apply(state, 8, "remote.watch", alert("w1", "recovered", state = "recovered", blocker = null, reason = "The agent is making progress again."))
        assertNull(state.marathon.watch.open)
        val notice = state.watchNotice!!
        assertEquals("recovered", notice.state)
        assertFalse(notice.actionable)
        assertEquals("The agent is making progress again.", notice.reason)
        // No alert: the chip falls back to watching/checked copy.
        assertEquals("Watching this turn", marathonChipCopy(state.marathon, busy = true, nowMs = 0))
    }

    @Test fun dismissalAndInfoNoticesAreNotOpenAlerts() {
        var state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "EXECUTOR_DOWN"))
        state = apply(state, 8, "remote.watch", alert("w1", "info", state = "dismissed", blocker = null, reason = "Dismissed; this alert kind is snoozed for 15 minutes."))
        assertNull(state.marathon.watch.open)
        assertEquals("dismissed", state.watchNotice?.state)
        assertFalse(state.watchNotice!!.actionable)
        // A malformed notice (no id) is ignored, not applied.
        val before = state
        state = apply(state, 9, "remote.watch", """{"kind":"alert","state":"open"}""")
        assertEquals(before.watchNotice, state.watchNotice)
        assertEquals(before.marathon, state.marathon)
    }

    @Test fun endedIncompleteIsAnOpenActionableNotice() {
        var state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(state, 8, "remote.watch", alert("w1", "recovered", state = "recovered", blocker = null, reason = "The agent is making progress again."))
        state = apply(
            state, 9, "remote.watch",
            alert("w2", "ended-incomplete", blocker = "ended-incomplete", reason = "The turn ended with work still open or blocked."),
        )
        assertTrue(state.watchNotice!!.actionable)
        assertEquals("w2", state.marathon.watch.open?.id)
        assertEquals("The turn ended incomplete", watchTitle("ended-incomplete"))
        assertEquals("Ended incomplete", watchKindLabel("ended-incomplete"))
    }

    @Test fun watcherCountersKeepTheOpenAlert() {
        var state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(
            state, 8, "remote.marathon",
            """
            {"enabled":true,"sessionId":"s1","since":"2026-11-16T12:00:00.000Z","origin":"remote","plan":null,
             "watcher":{"active":true,"checks":5,"lastCheckAt":"2026-11-16T12:05:00.000Z","lastVerdict":"progressing"}}
            """,
            turnId = null,
        )
        assertEquals("w1", state.marathon.watch.open?.id)
        assertEquals(5, state.marathon.watch.checks)
        assertEquals("progressing", state.marathon.watch.lastVerdict)
    }

    // --- lifecycle ----------------------------------------------------------

    @Test fun aNewSessionClearsTheSwitchAndNotice() {
        var state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(state, 8, "chat.session", """{"sessionId":"s2"}""", turnId = null)
        assertEquals(MarathonState(), state.marathon)
        assertNull(state.watchNotice)
    }

    @Test fun aNewTurnKeepsTheOpenAlertButDropsACollapsedSummary() {
        var state = apply(apply(synced, 6, "remote.marathon", marathonOn, turnId = null), 7, "remote.watch", alert("w1", "TOOL_HANG"))
        state = apply(state, 8, "chat.user", """{"text":"continue","origin":"remote","clientMessageId":"c2"}""", turnId = "t2")
        assertEquals("w1", state.watchNotice?.id)
        assertEquals("w1", state.marathon.watch.open?.id)
        // A collapsed recovery summary does not follow into the next turn.
        state = apply(state, 9, "remote.watch", alert("w1", "recovered", state = "recovered", blocker = null, reason = "The agent is making progress again."))
        state = apply(state, 10, "chat.user", """{"text":"again","origin":"remote","clientMessageId":"c3"}""", turnId = "t3")
        assertNull(state.watchNotice)
        assertNull(state.marathon.watch.open)
    }

    // --- resync parity ------------------------------------------------------

    @Test fun aResyncProjectionRestoresTheSwitchPlanAndOpenAlert() {
        // The live stream builds the state from envelopes…
        var streamed = apply(synced, 6, "remote.marathon", marathonOn, turnId = null)
        streamed = apply(
            streamed, 7, "remote.marathon",
            """
            {"enabled":true,"sessionId":"s1","since":"2026-11-16T12:00:00.000Z","origin":"remote","plan":$plan,
             "watcher":{"active":true,"checks":4,"lastCheckAt":"2026-11-16T12:04:00.000Z","lastVerdict":null}}
            """,
            turnId = null,
        )
        streamed = apply(streamed, 8, "remote.watch", alert("w1", "stuck", source = "watcher", blocker = "loop", reason = "Repeating the same action."))
        // …and a full resync must reach exactly the same state from the projection.
        val projection = frame(
            """
            {"instanceId":"i1","latestSequence":8,"sessionId":"s1","turn":{"status":"idle"},"messages":[],
             "marathon":{"enabled":true,"since":"2026-11-16T12:00:00.000Z","plan":$plan,
              "watch":{"open":{"id":"w1","kind":"stuck","at":"2026-11-16T12:04:00.000Z","reason":"Repeating the same action."},
               "lastVerdict":null,"lastCheckAt":"2026-11-16T12:04:00.000Z","checks":4}}}
            """,
        )
        val resynced = ChatReducer.fromProjection(projection)!!
        assertEquals(streamed.marathon, resynced.marathon)
        assertEquals(streamed.watchNotice, resynced.watchNotice)
        assertEquals(streamed, resynced)
        // A collapsed notice is not reconstructible from the projection: after a
        // resync only the open alert survives (deliberate, companion-authoritative).
        val collapsed = apply(streamed, 9, "remote.watch", alert("w1", "recovered", state = "recovered", blocker = null, reason = "The agent is making progress again."))
        val projectionAfterRecovery = frame(
            """
            {"instanceId":"i1","latestSequence":9,"sessionId":"s1","turn":{"status":"idle"},"messages":[],
             "marathon":{"enabled":true,"since":"2026-11-16T12:00:00.000Z","plan":$plan,
              "watch":{"open":null,"lastVerdict":null,"lastCheckAt":"2026-11-16T12:04:00.000Z","checks":4}}}
            """,
        )
        val afterResync = ChatReducer.fromProjection(projectionAfterRecovery)!!
        assertNull(afterResync.watchNotice)
        assertNull(afterResync.marathon.watch.open)
        assertEquals(collapsed.marathon, afterResync.marathon)
    }

    @Test fun marathonEnvelopesDedupeAndGapsResyncLikeEverythingElse() {
        val state = apply(synced, 6, "remote.marathon", marathonOn, turnId = null)
        // A duplicate replay changes nothing.
        assertEquals(state, ChatReducer.reduce(state, event(6, "remote.marathon", marathonOn, turnId = null)).state)
        // A gap still requests a full resync.
        assertEquals(ResyncReason.GAP, ChatReducer.reduce(state, event(8, "remote.watch", alert("w1", "TOOL_HANG"))).resync)
        // Another instance requests a resync too.
        val other = frame(
            """{"v":1,"instanceId":"i2","seq":7,"type":"remote.marathon","sessionId":"s1","body":$marathonOn}""",
        )
        assertEquals(ResyncReason.INSTANCE_CHANGED, ChatReducer.reduce(state, other).resync)
    }

    // --- chip and card text -------------------------------------------------

    @Test fun chipCopyFollowsThePanelStates() {
        val off = MarathonState()
        assertEquals("Every turn uses a live checklist", marathonChipCopy(off, busy = false, nowMs = 0))
        val on = MarathonState(enabled = true)
        assertEquals("Every turn uses a live checklist", marathonChipCopy(on, busy = false, nowMs = 0))
        assertEquals("Watching this turn", marathonChipCopy(on, busy = true, nowMs = 0))
        val checked = on.copy(watch = MarathonWatch(checks = 3, lastCheckAt = "2026-11-16T12:00:00.000Z"))
        val now = java.time.Instant.parse("2026-11-16T12:03:00.000Z").toEpochMilli()
        assertEquals("Checked 3m ago", marathonChipCopy(checked, busy = false, nowMs = now))
        val alert = checked.copy(watch = checked.watch.copy(open = WatchOpen("w1", "TOOL_HANG", null, "x")))
        assertEquals("May be stuck — review the alert", marathonChipCopy(alert, busy = true, nowMs = now))
    }

    @Test fun checkedAgoIsBoundedAndHonest() {
        val now = java.time.Instant.parse("2026-11-16T12:00:00.000Z").toEpochMilli()
        assertEquals("recently", watchCheckedAgo(null, now))
        assertEquals("recently", watchCheckedAgo("not a date", now))
        assertEquals("0s ago", watchCheckedAgo("2026-11-16T12:00:00.000Z", now))
        // A future timestamp never reads negative.
        assertEquals("0s ago", watchCheckedAgo("2026-11-16T12:00:30.000Z", now))
        assertEquals("45s ago", watchCheckedAgo("2026-11-16T11:59:15.000Z", now))
        assertEquals("2m ago", watchCheckedAgo("2026-11-16T11:58:00.000Z", now))
        assertEquals("2h ago", watchCheckedAgo("2026-11-16T10:00:00.000Z", now))
    }

    @Test fun planSummaryCountsOpenItems() {
        val carried = MarathonPlan(
            4,
            listOf(
                MarathonPlanItem("a", "completed"),
                MarathonPlanItem("b", "in_progress"),
                MarathonPlanItem("c", "pending"),
                MarathonPlanItem("d", "blocked"),
            ),
            "u", "t1",
        )
        assertEquals("Revision 4 · 2 open of 4", planSummary(carried))
        assertEquals("Revision 0 · 1 open of 1", planSummary(MarathonPlan(0, listOf(MarathonPlanItem("only", "pending")), "u", "t1")))
    }
}
