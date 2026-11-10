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
}
