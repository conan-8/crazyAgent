package dev.crazyagent.remote.app

import dev.crazyagent.remote.data.CloseCodes
import dev.crazyagent.remote.data.PromptImage
import dev.crazyagent.remote.data.ServerConfig
import dev.crazyagent.remote.notifications.PushMessage
import dev.crazyagent.remote.notifications.PushState
import dev.crazyagent.remote.state.ChatItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Fake-server HTTP/WS tests for the phone's connection, delivery, and
 * recovery rules. No model, Tailscale, or real companion is involved.
 */
class RemoteControllerTest {
    private val token = "0123456789abcdef".repeat(4)
    private lateinit var server: MockWebServer
    private lateinit var fake: FakeCompanion
    private lateinit var scope: CoroutineScope
    private val client = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
    private val ids = AtomicInteger()
    private val store = MemoryPendingStore()
    private var runJob: Job? = null

    @Before fun setUp() {
        fake = FakeCompanion(token)
        server = MockWebServer()
        server.dispatcher = fake
        server.start()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    @After fun tearDown() {
        scope.cancel()
        server.close()
    }

    private fun controller(pendingStore: PendingStore = store) = RemoteController(
        config = ServerConfig(server.url("/"), token),
        client = client,
        pendingStore = pendingStore,
        scope = scope,
        sleep = { delay(20) },
        random = { 0.0 },
        newId = { "client-${ids.incrementAndGet().toString().padStart(4, '0')}" },
    )

    private fun RemoteController.start(): RemoteController {
        runJob = scope.launch { run() }
        return this
    }

    private fun RemoteController.await(timeoutMs: Long = 5_000, predicate: (UiState) -> Boolean): UiState = runBlocking {
        withTimeout(timeoutMs) { state.first(predicate) }
    }

    private fun RemoteController.awaitLive() = await { it.link.status == LinkStatus.LIVE && it.chat.synced }

    private fun RemoteController.type(text: String) = updateComposer(text)

    @Test fun sendCarriesAuthAndJsonAndClearsOnceTheTurnStarts() {
        val c = controller().start()
        c.awaitLive()
        c.type("  open the cart  ")
        c.addImages(listOf(PromptImage("phone-image-1.png", "image/png", byteArrayOf(1, 2, 3))))
        c.send()
        val running = c.await { it.chat.turn.isActive && it.pending == null }
        val post = fake.messagePosts.single()
        assertEquals("client-0001", (post["clientMessageId"] as JsonPrimitive).content)
        assertEquals("open the cart", (post["text"] as JsonPrimitive).content)
        val image = (post["images"] as JsonArray).single().jsonObject
        assertEquals("image/png", (image["mimeType"] as JsonPrimitive).content)
        assertEquals("AQID", (image["data"] as JsonPrimitive).content)
        assertTrue(fake.authHeaders.all { it == "Bearer $token" })
        assertEquals("", running.composer)
        assertTrue(running.attachments.isEmpty())
        val user = running.chat.items.single() as ChatItem.User
        assertEquals("client-0001", user.clientMessageId)
        assertEquals(1, user.imageCount)
        assertNull(store.value)

        fake.draft("turn-1:s1", 0, "Two ")
        fake.draft("turn-1:s1", 4, "items.")
        c.await { it.chat.draft?.text == "Two items." }
        fake.finishTurn("Two items.", replacesStreamId = "turn-1:s1")
        val done = c.await { !it.chat.turn.isActive && it.chat.items.size == 3 }
        assertNull(done.chat.draft)
        assertEquals("done", done.chat.turn.outcome)
    }

    @Test fun planModeIsSentOnceAndConsumed() {
        val c = controller().start()
        c.awaitLive()
        c.togglePlanMode()
        c.type("plan the work")
        c.send()
        val running = c.await { it.chat.turn.isActive && it.pending == null }
        assertEquals("true", fake.messagePosts.single()["planMode"]?.jsonPrimitive?.content)
        assertEquals(false, running.planMode)
    }

    @Test fun busyRefusalPutsThePromptBackWithoutAnotherTurn() {
        fake.forceBusy = true
        val c = controller().start()
        c.awaitLive()
        c.type("buy it")
        c.send()
        val refused = c.await { it.pending == null && it.notice != null }
        assertEquals("buy it", refused.composer)
        assertEquals("A turn is already running.", refused.notice)
        assertEquals(0, fake.userMessageCount())
        assertNull(store.value)
    }

    @Test fun lostAcceptanceIsReconciledFromEventsWithoutResending() {
        fake.dropNextAcceptance = true
        val c = controller().start()
        c.awaitLive()
        c.type("check the order")
        c.send()
        val accepted = c.await { it.pending == null && it.chat.items.isNotEmpty() }
        assertEquals("client-0001", (accepted.chat.items.single() as ChatItem.User).clientMessageId)
        assertEquals(1, fake.userMessageCount())
        assertTrue(fake.messagePosts.all { (it["clientMessageId"] as JsonPrimitive).content == "client-0001" })
    }

    @Test fun lostAcceptanceIsReconciledFromStateWhenTheStreamIsStalled() {
        fake.dropNextAcceptance = true
        val c = controller().start()
        c.awaitLive()
        fake.muteLive = true
        c.type("check the order")
        c.send()
        c.await { it.pending == null }
        assertEquals(1, fake.messagePosts.size)
        assertEquals(1, fake.userMessageCount())
        assertNull(store.value)
    }

    @Test fun lostRequestIsRetriedOnlyWithTheSameId() {
        fake.loseNextMessage = true
        val c = controller().start()
        c.awaitLive()
        c.type("retry me")
        c.send()
        c.await { it.pending == null && it.chat.items.isNotEmpty() }
        assertEquals(2, fake.messagePosts.size)
        assertEquals(setOf("client-0001"), fake.messagePosts.map { (it["clientMessageId"] as JsonPrimitive).content }.toSet())
        assertEquals(1, fake.userMessageCount())
    }

    @Test fun companionRestartLeavesAnUncertainSendForReviewNeverResent() {
        fake.loseNextMessage = true
        val c = controller().start()
        c.awaitLive()
        fake.muteLive = true
        // Restart before the client can reconcile: the old cache and instance are gone.
        fake.refuseUpgrades = 100
        c.togglePlanMode()
        c.type("pay the invoice")
        c.send()
        fake.restart("fake-2")
        val review = c.await { it.pending?.phase == PendingPhase.NEEDS_REVIEW }
        assertTrue(review.pending!!.note!!.contains("restarted"))
        assertEquals(true, review.pending!!.planMode)
        assertEquals(1, fake.messagePosts.size)
        assertEquals(0, fake.userMessageCount())
        assertNotNull(store.value)
        assertEquals(true, store.value?.planMode)

        c.editPending()
        val restored = c.await { it.pending == null && it.planMode }
        assertEquals("pay the invoice", restored.composer)
        runBlocking { withTimeout(2_000) { while (store.value != null) delay(10) } }
    }

    @Test fun reconnectDuringATurnResumesFromTheLastSequence() {
        val c = controller().start()
        c.awaitLive()
        c.type("long task")
        c.send()
        c.await { it.chat.turn.isActive }
        fake.draft("turn-1:s1", 0, "Part one. ")
        val before = c.await { it.chat.draft?.text == "Part one. " }
        fake.dropStreams()
        fake.draft("turn-1:s1", 10, "Part two.")
        val after = c.await { it.chat.draft?.text == "Part one. Part two." }
        val resume = fake.eventRequests.last().url
        assertEquals("fake-1", resume.queryParameter("instance"))
        assertEquals(before.chat.lastSeq.toString(), resume.queryParameter("after"))
        assertEquals(1, after.chat.items.count { it is ChatItem.User })
    }

    @Test fun aSequenceGapForcesAFullResync() {
        val c = controller().start()
        c.awaitLive()
        val requestsBefore = fake.eventRequests.size
        fake.skipSequence()
        c.type("after the gap")
        c.send()
        val synced = c.await { it.chat.items.isNotEmpty() && it.link.status == LinkStatus.LIVE }
        assertTrue(fake.eventRequests.size > requestsBefore)
        assertNull(fake.eventRequests.last().url.queryParameter("instance"))
        assertEquals("client-0001", (synced.chat.items.single() as ChatItem.User).clientMessageId)
    }

    @Test fun revokedTokenStopsReconnecting() {
        val c = controller().start()
        c.awaitLive()
        fake.token = "f".repeat(64)
        fake.closeStreams(CloseCodes.TOKEN_REVOKED, "token revoked")
        val failed = c.await { it.link.status == LinkStatus.AUTH_FAILED }
        assertTrue(failed.link.detail!!.contains("revoked"))
        val count = fake.eventRequests.size
        runBlocking { delay(1_000) }
        assertEquals(count, fake.eventRequests.size)
    }

    @Test fun rejectedTokenOnUpgradeIsAnAuthFailure() {
        fake.token = "f".repeat(64)
        val c = controller().start()
        c.await { it.link.status == LinkStatus.AUTH_FAILED }
        runBlocking { delay(1_000) }
        assertEquals(1, server.requestCount)
    }

    @Test fun unavailableServerIsRetriedWithBackoff() {
        fake.refuseUpgrades = 2
        val c = controller().start()
        c.await { it.link.status == LinkStatus.RECONNECTING }
        c.awaitLive()
        assertEquals(3, fake.eventRequests.size)
    }

    @Test fun stopUsesTheRealLifecycleAndNewChatClears() {
        val c = controller().start()
        c.awaitLive()
        c.type("work")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        c.stop()
        c.await { it.chat.turn.status == "stopping" }
        assertEquals(1, fake.stopPosts.size)
        fake.completeStop()
        val stopped = c.await { !it.chat.turn.isActive }
        assertEquals("stopped", stopped.chat.turn.outcome)
        assertTrue(stopped.chat.items.last() is ChatItem.Stopped)

        c.newChat()
        val fresh = c.await { it.chat.sessionId == "session-2" }
        assertTrue(fresh.chat.items.isEmpty())
        assertEquals(1, fake.newPosts.size)
    }

    @Test fun processRecreationReconcilesAPersistedSendThatArrived() {
        val first = controller().start()
        first.awaitLive()
        fake.dropNextAcceptance = true
        fake.muteLive = true
        first.type("survive process death")
        first.send()
        runBlocking { withTimeout(2_000) { while (fake.userMessageCount() == 0) delay(10) } }
        // The process dies before the response or event is seen.
        runJob?.cancel()
        val persisted = MemoryPendingStore(store.value ?: StoredPending("client-0001", "survive process death", 0, "fake-1"))
        fake.muteLive = false

        val second = controller(persisted)
        runBlocking { second.restore() }
        second.start()
        second.await { it.pending == null && it.chat.items.isNotEmpty() }
        assertEquals(1, fake.messagePosts.size)
        runBlocking { withTimeout(2_000) { while (persisted.value != null) delay(10) } }
    }

    @Test fun processRecreationResendsATextOnlyPromptWithItsOriginalId() {
        fake.restart("fake-1")
        val persisted = MemoryPendingStore(StoredPending("client-orig1", "never arrived", 0, "fake-1"))
        val c = controller(persisted)
        runBlocking { c.restore() }
        c.start()
        val done = c.await { it.pending == null && it.chat.items.isNotEmpty() }
        assertEquals("client-orig1", (fake.messagePosts.single()["clientMessageId"] as JsonPrimitive).content)
        assertEquals("never arrived", (done.chat.items.single() as ChatItem.User).text)
    }

    @Test fun processRecreationWithLostImagesOrAnotherInstanceNeedsReview() {
        val withImages = MemoryPendingStore(StoredPending("client-img01", "see photo", 2, "fake-1"))
        val c1 = controller(withImages)
        runBlocking { c1.restore() }
        val review1 = c1.await { it.pending?.phase == PendingPhase.NEEDS_REVIEW }
        assertTrue(review1.pending!!.note!!.contains("images"))

        val otherInstance = MemoryPendingStore(StoredPending("client-old01", "from before", 0, "fake-0"))
        val c2 = controller(otherInstance)
        runBlocking { c2.restore() }
        c2.await { it.pending?.phase == PendingPhase.NEEDS_REVIEW }
        assertTrue(fake.messagePosts.isEmpty())
    }

    @Test fun deliberateResendAfterReviewUsesANewId() {
        val otherInstance = MemoryPendingStore(StoredPending("client-old01", "from before", 0, "fake-0"))
        val c = controller(otherInstance)
        runBlocking { c.restore() }
        c.start()
        c.awaitLive()
        c.await { it.pending?.phase == PendingPhase.NEEDS_REVIEW }
        c.resendPendingAsNew()
        val sent = c.await { it.pending == null && it.chat.items.isNotEmpty() }
        val id = (fake.messagePosts.single()["clientMessageId"] as JsonPrimitive).content
        assertTrue(id != "client-old01")
        assertEquals("from before", (sent.chat.items.single() as ChatItem.User).text)
    }

    @Test fun savedChatLoadsWithoutChangingTheLiveTranscript() {
        val c = controller().start()
        c.awaitLive()
        c.type("history title")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        fake.finishTurn("saved answer")
        val done = c.await { !it.chat.turn.isActive && it.chat.sessions.singleOrNull()?.title == "history title" }
        assertEquals(3, done.chat.sessions.single().messageCount)

        c.openHistory("session-1")
        val opened = c.await { it.historyOpen != null }
        assertEquals("history title", opened.historyOpen?.title)
        assertTrue(opened.historyOpen!!.items.any { it is ChatItem.Assistant && it.text == "saved answer" })
        assertEquals(done.chat.items, opened.chat.items)

        c.closeHistory()
        val closed = c.await { it.historyOpen == null }
        assertEquals(done.chat.items, closed.chat.items)
        assertEquals(done.chat.sessions, closed.chat.sessions)
    }

    @Test fun screenshotsAreFetchedLatestWinsAndKeptWhileANewerOneLoads() {
        val c = controller().start()
        c.awaitLive()
        assertNull(c.state.value.liveImage)
        fake.screenshot("shot-a", byteArrayOf(1, 2, 3))
        val first = c.await { it.liveImage?.id == "shot-a" }
        assertTrue(first.liveImage!!.bytes.contentEquals(byteArrayOf(1, 2, 3)))
        assertEquals(1280, first.liveImage!!.width)
        assertEquals(false, first.liveImageLoading)
        assertTrue(fake.authHeaders.all { it == "Bearer $token" })

        // A transient failure is retried; the previous image stays up meanwhile.
        fake.failScreenshots = 1
        fake.screenshot("shot-b", byteArrayOf(9, 9), width = 720, height = 2400)
        val second = c.await { it.liveImage?.id == "shot-b" }
        assertTrue(second.liveImage!!.bytes.contentEquals(byteArrayOf(9, 9)))
        assertEquals(listOf("shot-a", "shot-b", "shot-b"), fake.screenshotGets.toList())
    }

    @Test fun anExpiredScreenshotKeepsTheOldImageAndIsNotRequestedForever() {
        val c = controller().start()
        c.awaitLive()
        fake.screenshot("shot-a", byteArrayOf(1))
        c.await { it.liveImage?.id == "shot-a" }
        fake.screenshot("shot-gone", byteArrayOf(2))
        fake.expireScreenshot("shot-gone")
        c.await { it.chat.screenshot?.id == "shot-gone" }
        // More frames arrive; the missing image must not be re-requested for each of them.
        c.type("go")
        c.send()
        c.await { it.chat.turn.isActive }
        repeat(5) { index -> fake.draft("turn-1:s1", index, "x") }
        val after = c.await { it.chat.draft?.text == "xxxxx" }
        assertEquals("shot-a", after.liveImage?.id)
        runBlocking { delay(300) }
        assertEquals(3, fake.screenshotGets.count { it == "shot-gone" })
        // The app says the newest capture is gone instead of spinning forever.
        val gone = c.await { it.liveImageUnavailable }
        assertEquals(false, gone.liveImageLoading)
        assertEquals("shot-a", gone.liveImage?.id)
        assertNull("the caption must not describe the missing capture", gone.liveImageMeta)
    }

    @Test fun aReconnectRestoresTheLatestScreenshotFromTheProjection() {
        fake.screenshot("shot-a", byteArrayOf(7))
        val c = controller().start()
        val live = c.await { it.liveImage?.id == "shot-a" }
        assertTrue(live.liveImage!!.bytes.contentEquals(byteArrayOf(7)))
        // A companion restart has no screenshot: the live view clears.
        fake.restart("fake-2")
        c.await { it.chat.instanceId == "fake-2" && it.chat.synced && it.liveImage == null }
    }

    @Test fun steeringStopsTheRunningTurnAndSendsTheMessageOnce() {
        val c = controller().start()
        c.awaitLive()
        c.type("long task")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        assertEquals(false, c.state.value.canSteer)
        c.type("go left instead")
        assertTrue(c.state.value.canSteer)
        assertEquals(false, c.state.value.canSend)
        c.send()
        val steering = c.await { it.pending?.phase == PendingPhase.STEERING }
        assertEquals("", steering.composer)
        c.await { it.chat.turn.status == "stopping" }
        val post = fake.messagePosts.last()
        assertEquals("true", post["steer"]?.jsonPrimitive?.content)
        assertEquals(true, store.value?.steer)
        // Only one message may wait to steer.
        c.type("another")
        assertEquals(false, c.state.value.canSteer)
        c.type("")

        fake.completeStop()
        val running = c.await { it.pending == null && it.chat.turn.isActive }
        assertEquals("turn-2", running.chat.turn.turnId)
        val users = running.chat.items.filterIsInstance<ChatItem.User>()
        assertEquals(listOf("long task", "go left instead"), users.map { it.text })
        assertTrue(running.chat.items.any { it is ChatItem.Stopped })
        assertEquals(2, fake.messagePosts.size)
        assertTrue(fake.stopPosts.isEmpty())
        assertNull(store.value)
    }

    @Test fun aSteerThatNeverStartsGoesToReviewAfterTheNextResync() {
        val c = controller().start()
        c.awaitLive()
        c.type("long task")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        c.type("redirect")
        c.send()
        c.await { it.pending?.phase == PendingPhase.STEERING }
        fake.dropPendingSteer = true
        fake.completeStop()
        c.await { !it.chat.turn.isActive }
        assertEquals(PendingPhase.STEERING, c.state.value.pending?.phase)
        fake.restart("fake-2") // the next connection is a full resync
        val review = c.await { it.pending?.phase == PendingPhase.NEEDS_REVIEW }
        assertEquals("redirect", review.pending?.text)
        assertEquals(2, fake.messagePosts.size)
    }

    @Test fun continuingASavedChatResyncsItsMessagesAndTheNextSendUsesIt() {
        val c = controller().start()
        c.awaitLive()
        c.type("old question")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        fake.finishTurn("old answer")
        c.await { !it.chat.turn.isActive && it.chat.items.size == 3 }
        c.newChat()
        c.await { it.chat.sessionId == "session-2" && it.chat.items.isEmpty() && it.canStartNew }

        c.openHistory("session-1")
        c.await { it.historyOpen?.sessionId == "session-1" }
        c.resumeChat("session-1")
        val resumed = c.await { it.chat.sessionId == "session-1" && it.chat.items.size == 3 && it.chat.synced && it.link.status == LinkStatus.LIVE && !it.resumeInFlight }
        assertNull(resumed.historyOpen)
        assertEquals(false, resumed.resumeInFlight)
        assertEquals(listOf("session-1"), fake.resumePosts.toList())
        assertEquals("old question", (resumed.chat.items.first() as ChatItem.User).text)

        c.type("and then?")
        c.send()
        val running = c.await { it.chat.turn.isActive && it.pending == null }
        assertEquals(4, running.chat.items.size)
    }

    @Test fun aChatThatCannotBeContinuedLeavesTheCurrentOneInPlace() {
        val c = controller().start()
        c.awaitLive()
        c.type("old question")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        // Refused while a turn runs: nothing is even requested.
        c.resumeChat("session-1")
        assertTrue(fake.resumePosts.isEmpty())
        fake.finishTurn("old answer")
        c.await { !it.chat.turn.isActive }
        c.newChat()
        c.await { it.chat.sessionId == "session-2" && it.canStartNew }
        fake.unresumable += "session-1"
        c.resumeChat("session-1")
        val refused = c.await { it.notice == "This chat can no longer be continued." }
        assertEquals("session-2", refused.chat.sessionId)
        assertEquals(false, refused.resumeInFlight)
        c.resumeChat("../state")
        assertEquals(1, fake.resumePosts.size)
    }

    @Test fun aFreshCaptureIsRequestedOnceAndShownWithItsSource() {
        val c = controller().start()
        c.awaitLive()
        assertTrue(c.state.value.canCapture)
        c.captureScreen()
        val shown = c.await { it.liveImage?.id == "shot-manual-1" && !it.snapshotInFlight }
        assertEquals("manual", shown.liveImageMeta?.source)
        assertEquals(1, fake.snapshotPosts.size)
        assertEquals("client-0001", fake.snapshotPosts[0]["clientCommandId"]!!.jsonPrimitive.content)
        // The next capture is a new command, not a replay of the first.
        c.captureScreen()
        c.await { it.liveImage?.id == "shot-manual-2" }
        assertEquals("client-0002", fake.snapshotPosts[1]["clientCommandId"]!!.jsonPrimitive.content)
    }

    @Test fun noCaptureIsRequestedWhileTheAgentWorksOrThePanelIsClosed() {
        val c = controller().start()
        c.awaitLive()
        c.type("go")
        c.send()
        val busy = c.await { it.chat.turn.isActive }
        assertEquals(false, busy.canCapture)
        c.captureScreen()
        runBlocking { delay(150) }
        assertEquals(0, fake.snapshotPosts.size)
        fake.finishTurn("ok")
        c.await { !it.busy && it.canCapture }

        // Health says the side panel is closed: the button is off and nothing is sent.
        fake.uiConnected = false
        fake.restart("fake-2")
        val closed = c.await { it.chat.instanceId == "fake-2" && it.chat.synced }
        assertEquals(false, closed.canCapture)
        c.captureScreen()
        runBlocking { delay(150) }
        assertEquals(0, fake.snapshotPosts.size)
    }

    @Test fun aRefusedCaptureIsReportedAndLeavesTheViewAlone() {
        val c = controller().start()
        c.awaitLive()
        fake.screenshot("shot-a", byteArrayOf(1))
        c.await { it.liveImage?.id == "shot-a" }
        // The companion's own view of the panel is authoritative, whatever the phone last heard.
        fake.uiConnected = false
        c.captureScreen()
        val refused = c.await { it.notice != null && !it.snapshotInFlight }
        assertTrue(refused.notice!!.contains("side panel"))
        assertEquals("shot-a", refused.liveImage?.id)
    }

    @Test fun aHelpRequestWaitsForTheUserAndAReplyContinuesTheSameChat() {
        val c = controller().start()
        c.awaitLive()
        c.type("check my inbox")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        fake.finishTurnNeedingHelp("login", "Sign in to the mail site, then tell me to continue.")
        val waiting = c.await { it.chat.turn.isWaiting && it.liveImage?.id == "shot-help" }
        assertEquals("login", waiting.chat.help!!.category)
        assertEquals("Sign in to the mail site, then tell me to continue.", waiting.chat.help!!.reason)
        assertEquals("shot-help", waiting.chat.help!!.screenshotId)
        assertEquals("help", waiting.liveImageMeta?.source)
        assertEquals(false, waiting.busy)
        assertTrue("a fresh capture is allowed while waiting", waiting.canCapture)
        val session = waiting.chat.sessionId

        // The reply is an ordinary send in the same session; it clears the request.
        c.type("signed in")
        assertTrue(c.state.value.canSend)
        c.send()
        val running = c.await { it.chat.turn.isActive && it.pending == null }
        assertNull(running.chat.help)
        assertEquals(session, running.chat.sessionId)
        assertEquals(2, fake.messagePosts.size)
        assertNull("a reply is not a steer", fake.messagePosts[1]["steer"])
        assertEquals(2, fake.userMessageCount())
    }

    @Test fun aHelpRequestSurvivesAReconnectAndANewChatClearsIt() {
        val c = controller().start()
        c.awaitLive()
        c.type("go")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        fake.finishTurnNeedingHelp("captcha", "Solve the CAPTCHA.", screenshotId = null)
        val waiting = c.await { it.chat.turn.isWaiting }
        assertNull(waiting.chat.help!!.screenshotId)
        assertNotNull(waiting.chat.help!!.captureError)

        // A dropped stream that cannot replay resyncs from the projection.
        fake.skipSequence()
        fake.dropStreams()
        c.nudge()
        val back = c.await { it.link.status == LinkStatus.LIVE && it.chat.synced && it.chat.turn.isWaiting && it.chat.help != null }
        assertEquals("captcha", back.chat.help!!.category)

        c.newChat()
        val fresh = c.await { it.chat.sessionId == "session-2" }
        assertNull(fresh.chat.help)
        assertEquals(false, fresh.chat.turn.isWaiting)
    }

    @Test fun pushRegistrationIsSentWithAuthAndReportedHonestly() {
        val c = controller().start()
        c.awaitLive()
        assertEquals(PushState.Status.OFF_IN_APP, c.state.value.push.status)
        runBlocking { c.registerPush("android-device-1", "fcm-token-" + "a".repeat(120), "0.3.0") }
        assertEquals(PushState.Status.REGISTERED, c.state.value.push.status)
        val body = fake.pushDevices["android-device-1"]!!
        assertEquals("android", body["platform"]!!.jsonPrimitive.content)
        assertEquals("0.3.0", body["appVersion"]!!.jsonPrimitive.content)
        assertEquals("fcm-token-" + "a".repeat(120), body["fcmToken"]!!.jsonPrimitive.content)
        assertTrue(fake.authHeaders.all { it == "Bearer $token" })

        // A rotated token replaces the same device's registration.
        runBlocking { c.registerPush("android-device-1", "fcm-token-" + "b".repeat(120), "0.3.0") }
        assertEquals(1, fake.pushDevices.size)
        assertTrue(fake.pushDevices["android-device-1"]!!["fcmToken"]!!.jsonPrimitive.content.contains("bbb"))

        runBlocking { c.unregisterPush("android-device-1") }
        assertEquals(listOf("android-device-1"), fake.pushDeletes.toList())
        assertTrue(fake.pushDevices.isEmpty())
    }

    @Test fun pushThatTheComputerCannotSendOrThatFailsIsNotShownAsOn() {
        val c = controller().start()
        c.awaitLive()
        fake.pushConfigured = false
        runBlocking { c.registerPush("android-device-1", "fcm-token-" + "a".repeat(120), "0.3.0") }
        assertEquals(PushState.Status.OFF_ON_COMPUTER, c.state.value.push.status)
        assertTrue(fake.pushDevices.isEmpty())

        // A rejected token is an auth failure for the whole pairing, not a push quirk.
        fake.token = "f".repeat(64)
        runBlocking { c.registerPush("android-device-1", "fcm-token-" + "a".repeat(120), "0.3.0") }
        assertEquals(PushState.Status.FAILED, c.state.value.push.status)
        assertEquals(LinkStatus.AUTH_FAILED, c.state.value.link.status)
    }

    @Test fun openingFromANotificationResyncsAndSaysWhenTheCompanionRestarted() {
        val c = controller().start()
        c.awaitLive()
        c.type("go")
        c.send()
        c.await { it.chat.turn.isActive && it.pending == null }
        fake.finishTurnNeedingHelp("login", "Sign in.")
        val waiting = c.await { it.chat.turn.isWaiting }
        val resyncsBefore = fake.eventRequests.count { it.url.queryParameter("instance") == null }

        // Same companion run: a full resync, the waiting chat is shown, no warning.
        c.openedFromNotification(PushMessage(PushMessage.Type.HELP, waiting.chat.help!!.turnId!!, "fake-1", waiting.chat.lastSeq))
        fake.dropStreams()
        c.nudge()
        c.await { fake.eventRequests.count { request -> request.url.queryParameter("instance") == null } > resyncsBefore && it.link.status == LinkStatus.LIVE && it.chat.synced }
        val shown = c.state.value
        assertTrue(shown.chat.turn.isWaiting)
        assertEquals("login", shown.chat.help!!.category)
        assertNull(shown.notice)

        // A notification from a companion run that no longer exists is called out.
        fake.restart("fake-2")
        c.await { it.chat.instanceId == "fake-2" && it.chat.synced }
        c.dismissNotice()
        c.openedFromNotification(PushMessage(PushMessage.Type.DONE, "turn-1", "fake-1", 9))
        fake.dropStreams()
        c.nudge()
        val stale = c.await { it.notice?.contains("restarted after that notification") == true }
        assertEquals("fake-2", stale.chat.instanceId)
        assertNull(stale.chat.help)
    }
}
