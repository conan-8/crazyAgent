package dev.crazyagent.remote.state

import dev.crazyagent.remote.data.RemoteJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * V6 (MARATHON-V2-PLAN.md §3.7): the live checklist on the phone. The running
 * turn's plan arrives as `remote.plan` and projects on `/state.turn.plan`;
 * at every turn boundary it is null and the carried plan takes over. Frames
 * are hand-written to the hub's shape; the recorded real-hub fixture is
 * covered separately by [ReducerFixtureTest].
 */
class MarathonLivePlanTest {
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

    private val items1 = """[{"content":"Fill the form","status":"in_progress"},{"content":"Place the order","status":"pending"},{"content":"Verify","status":"pending"}]"""
    private val items2 = """[{"content":"Fill the form","status":"completed"},{"content":"Place the order","status":"in_progress"},{"content":"Verify","status":"pending"}]"""

    private fun running(): ChatState = apply(synced, 6, "chat.user", """{"text":"go","origin":"remote","clientMessageId":"c1"}""")

    @Test fun remotePlanMirrorsTheLiveChecklist() {
        var state = running()
        assertNull(state.turn.plan)
        state = apply(state, 7, "remote.plan", """{"turnId":"t1","revision":1,"items":$items1,"awaitingUser":false}""")
        val plan = state.turn.plan!!
        assertEquals(1, plan.revision)
        assertEquals(3, plan.items.size)
        assertEquals(3, plan.openCount)
        assertEquals(false, plan.awaitingUser)
        // A new revision replaces the list; awaitingUser rides along.
        state = apply(state, 8, "remote.plan", """{"turnId":"t1","revision":2,"items":$items2,"awaitingUser":true}""")
        assertEquals(2, state.turn.plan!!.revision)
        assertEquals(2, state.turn.plan!!.openCount)
        assertTrue(state.turn.plan!!.awaitingUser)
        assertEquals("completed", state.turn.plan!!.items[0].status)
    }

    @Test fun malformedRemotePlanKeepsTheLastGoodPlan() {
        var state = running()
        state = apply(state, 7, "remote.plan", """{"turnId":"t1","revision":1,"items":$items1,"awaitingUser":false}""")
        val good = state.turn.plan
        val bad = listOf(
            """{"turnId":"t1","revision":-1,"items":$items1}""",
            """{"turnId":"t1","revision":1.5,"items":$items1}""",
            """{"turnId":"t1","revision":1,"items":[]}""",
            """{"turnId":"t1","revision":1,"items":[{"content":"  ","status":"pending"}]}""",
            """{"turnId":"t1","revision":1,"items":[{"content":"x","status":"done"}]}""",
            """{"turnId":"t1","revision":1,"items":[{"content":"x","status":"pending"},{"content":"x","status":"completed"}]}""",
            """{"turnId":"t1","revision":1,"items":[{"content":"x"}]}""",
            """{"turnId":"t1","revision":1,"items":"nope"}""",
            """{"turnId":"t1","items":$items1}""",
        )
        var seq = 8L
        for (body in bad) {
            state = apply(state, seq++, "remote.plan", body)
            assertEquals("malformed plan must keep the last good one: $body", good, state.turn.plan)
        }
    }

    @Test fun theLivePlanClearsAtEveryTurnBoundary() {
        var state = running()
        state = apply(state, 7, "remote.plan", """{"turnId":"t1","revision":1,"items":$items1,"awaitingUser":false}""")
        // chat.turn at the end carries plan:null (the hub clears it).
        state = apply(state, 8, "chat.turn", """{"status":"idle","turnId":"t1","outcome":"done","plan":null}""")
        assertNull(state.turn.plan)
        // A new prompt starts empty even if the previous turn had a plan.
        state = apply(state, 9, "remote.plan", """{"turnId":"t1","revision":2,"items":$items2,"awaitingUser":false}""")
        state = apply(state, 10, "chat.user", """{"text":"again","origin":"remote","clientMessageId":"c2"}""", turnId = "t2")
        assertNull(state.turn.plan)
        // A session change clears it too.
        state = apply(state, 11, "remote.plan", """{"turnId":"t2","revision":1,"items":$items1,"awaitingUser":false}""", turnId = "t2")
        state = apply(state, 12, "chat.session", """{"sessionId":"s2"}""", turnId = null)
        assertNull(state.turn.plan)
    }

    @Test fun chatTurnCanCarryAnAuthoritativePlan() {
        // The projection's turn.plan rides chat.turn; turnOf parses it.
        val state = apply(synced, 6, "chat.turn", """{"status":"running","turnId":"t1","plan":{"turnId":"t1","revision":3,"items":$items2,"awaitingUser":true}}""")
        assertEquals(3, state.turn.plan!!.revision)
        assertTrue(state.turn.plan!!.awaitingUser)
        // A malformed plan on chat.turn fails closed to null.
        val bad = apply(synced, 6, "chat.turn", """{"status":"running","turnId":"t1","plan":{"revision":1,"items":[]}}""")
        assertNull(bad.turn.plan)
    }

    @Test fun aResyncProjectionRestoresTheLivePlan() {
        var streamed = running()
        streamed = apply(streamed, 7, "remote.plan", """{"turnId":"t1","revision":2,"items":$items2,"awaitingUser":true}""")
        val projection = frame(
            """
            {"instanceId":"i1","latestSequence":7,"sessionId":"s1","messages":[],
             "turn":{"status":"running","turnId":"t1","origin":"remote","clientMessageId":"c1",
              "plan":{"turnId":"t1","revision":2,"items":$items2,"awaitingUser":true}}}
            """,
        )
        val resynced = ChatReducer.fromProjection(projection)!!
        assertEquals(streamed.turn.plan, resynced.turn.plan)
        assertEquals(streamed.turn, resynced.turn)
        // Without a plan block the live plan is null (old companion / boundary).
        val noPlan = ChatReducer.fromProjection(frame(
            """{"instanceId":"i1","latestSequence":7,"sessionId":"s1","messages":[],"turn":{"status":"running","turnId":"t1"}}""",
        ))!!
        assertNull(noPlan.turn.plan)
    }

    @Test fun theCarriedPlanStillArrivesViaRemoteMarathon() {
        // V6 does not change the carry-over path: at turn end the live plan is
        // gone and remote.marathon carries the stored list.
        var state = running()
        state = apply(state, 7, "remote.plan", """{"turnId":"t1","revision":2,"items":$items2,"awaitingUser":false}""")
        state = apply(state, 8, "chat.turn", """{"status":"idle","turnId":"t1","outcome":"done","plan":null}""")
        state = apply(
            state, 9, "remote.marathon",
            """{"enabled":true,"sessionId":"s1","since":"2026-11-17T12:00:00.000Z","origin":"remote",
                "plan":{"revision":2,"items":$items2,"updatedAt":"2026-11-17T12:05:00.000Z","turnId":"t1"},
                "watcher":{"active":false,"checks":0,"lastCheckAt":null,"lastVerdict":null}}""",
            turnId = null,
        )
        assertNull(state.turn.plan)
        assertEquals(2, state.marathon.plan!!.revision)
        assertEquals(2, state.marathon.plan!!.openCount)
    }

    @Test fun planSummaryLabelsLiveAndCarriedPlansAlike() {
        assertEquals("Revision 2 · 2 open of 3", planSummary(2, listOf(
            MarathonPlanItem("a", "completed"),
            MarathonPlanItem("b", "in_progress"),
            MarathonPlanItem("c", "pending"),
        )))
        assertEquals("Revision 1 · 1 open of 1", planSummary(1, listOf(MarathonPlanItem("only", "pending"))))
        assertEquals("Revision 0 · 0 open of 1", planSummary(0, listOf(MarathonPlanItem("done", "completed"))))
        val carried = MarathonPlan(4, listOf(MarathonPlanItem("a", "pending"), MarathonPlanItem("b", "blocked")), "u", "t1")
        assertEquals(planSummary(carried.revision, carried.items), planSummary(carried))
    }
}
