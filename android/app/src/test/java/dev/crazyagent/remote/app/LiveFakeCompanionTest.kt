package dev.crazyagent.remote.app

import dev.crazyagent.remote.data.ServerConfig
import dev.crazyagent.remote.state.ChatItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Opt-in contract check against the real Node remote API
 * (`node scripts/fake-remote-companion.mjs`). Skipped unless
 * CRAZYAGENT_FAKE_URL and CRAZYAGENT_FAKE_TOKEN_FILE are set.
 */
class LiveFakeCompanionTest {
    @Test fun pairsSendsStreamsStopsAndStartsANewChat() {
        val url = System.getenv("CRAZYAGENT_FAKE_URL")
        val tokenFile = System.getenv("CRAZYAGENT_FAKE_TOKEN_FILE")
        assumeTrue("set CRAZYAGENT_FAKE_URL and CRAZYAGENT_FAKE_TOKEN_FILE", !url.isNullOrBlank() && !tokenFile.isNullOrBlank())
        val token = java.io.File(tokenFile!!).readText().trim()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val c = RemoteController(ServerConfig(url!!.toHttpUrl(), token), OkHttpClient(), MemoryPendingStore(), scope)
            scope.launch { c.run() }
            fun await(ms: Long = 15_000, p: (UiState) -> Boolean) = runBlocking { withTimeout(ms) { c.state.first(p) } }

            val live = await { it.link.status == LinkStatus.LIVE && it.chat.synced }
            assertEquals("fake/scripted", live.chat.health.model)
            val before = live.chat.items.size

            c.updateComposer("hello from the JVM client")
            c.send()
            await { it.chat.draft != null }
            val done = await { it.chat.items.size > before && !it.chat.turn.isActive && it.chat.turn.outcome != null }
            assertEquals("done", done.chat.turn.outcome)
            val turnItems = done.chat.items.drop(before)
            assertTrue(turnItems.first() is ChatItem.User)
            assertTrue(turnItems.any { it is ChatItem.ToolCall && it.result?.ok == true })
            assertTrue(turnItems.last() is ChatItem.Done)

            c.updateComposer("slow one to stop")
            c.send()
            await { it.chat.turn.isActive && it.pending == null }
            c.stop()
            val stopped = await { !it.chat.turn.isActive && it.chat.turn.outcome == "stopped" }
            assertTrue(stopped.chat.items.last() is ChatItem.Stopped)

            val session = stopped.chat.sessionId
            c.newChat()
            val fresh = await { it.chat.sessionId != session }
            assertTrue(fresh.chat.items.isEmpty())

            // A fresh capture on request: real PNG bytes arrive behind the new ID.
            await { it.canCapture }
            c.captureScreen()
            val captured = await { it.liveImage != null && it.liveImageMeta?.source == "manual" && !it.snapshotInFlight }
            val png = captured.liveImage!!.bytes
            assertTrue(png.size > 100 && png[0] == 0x89.toByte() && png[1] == 'P'.code.toByte())
            assertEquals(1280, captured.liveImage!!.width)

            // A blocked turn waits for the user with its own capture; the reply continues the same chat.
            c.updateComposer("you will hit a captcha")
            c.send()
            val waiting = await { it.chat.turn.isWaiting && it.chat.help != null && it.liveImage?.id == it.chat.help.screenshotId }
            assertEquals("captcha", waiting.chat.help!!.category)
            assertEquals("help", waiting.liveImageMeta?.source)
            assertEquals(null, waiting.chat.help!!.captureError)
            val waitingSession = waiting.chat.sessionId
            c.updateComposer("solved it, carry on")
            c.send()
            await { it.chat.turn.isActive && it.pending == null && it.chat.help == null }
            val replied = await { !it.chat.turn.isActive && it.chat.turn.outcome == "done" && !it.chat.turn.isWaiting }
            assertEquals(waitingSession, replied.chat.sessionId)

            // This companion has no FCM key: registering must say so, not claim it is on.
            runBlocking { c.registerPush("android-live-test", "fcm-token-" + "a".repeat(120), "0.3.0") }
            assertEquals(dev.crazyagent.remote.notifications.PushState.Status.OFF_ON_COMPUTER, c.state.value.push.status)
        } finally {
            scope.cancel()
        }
    }

    /**
     * M5 gate: the real phone client against the real Node fake API's
     * "marathon-stuck" turn — the chip flips only on remote.marathon, the
     * watcher's TOOL_HANG alert opens the watch card mid-turn (chip still
     * tappable), "It's fine" acks through POST /marathon/watch/ack, and the
     * PARTIAL ending carries the plan checklist plus an ended-incomplete card.
     */
    @Test fun marathonStuckShowsChipWatchCardAndChecklist() {
        val url = System.getenv("CRAZYAGENT_FAKE_URL")
        val tokenFile = System.getenv("CRAZYAGENT_FAKE_TOKEN_FILE")
        assumeTrue("set CRAZYAGENT_FAKE_URL and CRAZYAGENT_FAKE_TOKEN_FILE", !url.isNullOrBlank() && !tokenFile.isNullOrBlank())
        val token = java.io.File(tokenFile!!).readText().trim()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val c = RemoteController(ServerConfig(url!!.toHttpUrl(), token), OkHttpClient(), MemoryPendingStore(), scope)
            scope.launch { c.run() }
            fun await(ms: Long = 30_000, p: (UiState) -> Boolean) = runBlocking { withTimeout(ms) { c.state.first(p) } }

            await { it.link.status == LinkStatus.LIVE && it.chat.synced }
            assertEquals(false, c.state.value.chat.marathon.enabled)

            // The chip: no optimistic flip — it lights only on remote.marathon.
            c.toggleMarathon()
            val on = await { it.chat.marathon.enabled && !it.marathonInFlight }
            assertTrue(on.canToggleMarathon)

            c.updateComposer("marathon-stuck demo")
            c.send()
            await { it.chat.turn.isActive && it.pending == null }

            // The deterministic watcher alerts mid-turn; the card is actionable
            // and the chip stays visible and tappable while busy.
            val alert = await { it.chat.watchNotice?.actionable == true && it.chat.marathon.watch.open != null }
            assertEquals("TOOL_HANG", alert.chat.marathon.watch.open!!.kind)
            assertTrue(alert.chat.turn.isActive)
            assertTrue(alert.canToggleMarathon)
            assertTrue(alert.canAckWatch)

            // "It's fine" goes through the real ack route and the dismissal
            // arrives on the stream.
            c.ackWatch()
            val dismissed = await { it.chat.marathon.watch.open == null && !it.watchAckInFlight }
            assertEquals("dismissed", dismissed.chat.watchNotice?.state)

            // The turn ends PARTIAL: the carried checklist arrives with
            // remote.marathon and the ended-incomplete notice opens the card.
            val ended = await { !it.chat.turn.isActive && it.chat.marathon.plan != null && it.chat.watchNotice?.kind == "ended-incomplete" }
            assertTrue(ended.chat.watchNotice!!.actionable)
            assertEquals("ended-incomplete", ended.chat.marathon.watch.open?.kind)
            val plan = ended.chat.marathon.plan!!
            assertEquals(2, plan.revision)
            assertEquals(3, plan.items.size)
            assertEquals(2, plan.openCount)
            assertEquals(listOf("completed", "in_progress", "pending"), plan.items.map { it.status })
            assertEquals("Fill the shipping form", plan.items[0].content)
            // The switch survives the turn; the checklist is the phone's first.
            assertTrue(ended.chat.marathon.enabled)

            // A new chat resets the switch, the plan, and the notice.
            val session = ended.chat.sessionId
            c.newChat()
            val fresh = await { it.chat.sessionId != session }
            assertEquals(false, fresh.chat.marathon.enabled)
            assertNull(fresh.chat.marathon.plan)
            assertNull(fresh.chat.watchNotice)
        } finally {
            scope.cancel()
        }
    }

    /**
     * V6 gate: the checklist updates MID-TURN through the real phone client
     * against the real Node fake API. The marathon-stuck turn emits plan
     * revision 1 before its hung call and revision 2 after recovery; the phone
     * must show both live (turn.plan), then hand off to the carried plan
     * (marathon.plan) at turn end with turn.plan cleared.
     */
    @Test fun marathonLiveChecklistUpdatesMidTurn() {
        val url = System.getenv("CRAZYAGENT_FAKE_URL")
        val tokenFile = System.getenv("CRAZYAGENT_FAKE_TOKEN_FILE")
        assumeTrue("set CRAZYAGENT_FAKE_URL and CRAZYAGENT_FAKE_TOKEN_FILE", !url.isNullOrBlank() && !tokenFile.isNullOrBlank())
        val token = java.io.File(tokenFile!!).readText().trim()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val c = RemoteController(ServerConfig(url!!.toHttpUrl(), token), OkHttpClient(), MemoryPendingStore(), scope)
            scope.launch { c.run() }
            fun await(ms: Long = 30_000, p: (UiState) -> Boolean) = runBlocking { withTimeout(ms) { c.state.first(p) } }

            await { it.link.status == LinkStatus.LIVE && it.chat.synced }
            c.toggleMarathon()
            await { it.chat.marathon.enabled && !it.marathonInFlight }
            c.updateComposer("marathon-stuck live plan")
            c.send()
            await { it.chat.turn.isActive && it.pending == null }

            // Revision 1 renders LIVE while the turn runs (before the hang ends).
            val live1 = await { it.chat.turn.isActive && it.chat.turn.plan?.revision == 1 }
            assertEquals(3, live1.chat.turn.plan!!.items.size)
            assertEquals(3, live1.chat.turn.plan!!.openCount)
            assertEquals("in_progress", live1.chat.turn.plan!!.items[0].status)
            assertNull("the carried plan is not published mid-turn", live1.chat.marathon.plan)

            // Revision 2 advances the live list (or has already handed off).
            await { it.chat.turn.plan?.revision == 2 || it.chat.marathon.plan?.revision == 2 }

            // Turn end: the live plan clears; the carried list takes over.
            val ended = await { !it.chat.turn.isActive && it.chat.marathon.plan != null }
            assertNull(ended.chat.turn.plan)
            assertEquals(2, ended.chat.marathon.plan!!.revision)
            assertEquals(listOf("completed", "in_progress", "pending"), ended.chat.marathon.plan!!.items.map { it.status })

            // Leave a clean state (marathon off) for the other live tests.
            val session = ended.chat.sessionId
            c.newChat()
            await { it.chat.sessionId != session && !it.chat.marathon.enabled }
        } finally {
            scope.cancel()
        }
    }
}
