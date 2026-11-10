package dev.crazyagent.remote.app

import dev.crazyagent.remote.data.ApiResult
import dev.crazyagent.remote.data.Backoff
import dev.crazyagent.remote.data.CloseCodes
import dev.crazyagent.remote.data.PromptImage
import dev.crazyagent.remote.data.RemoteApi
import dev.crazyagent.remote.data.ServerConfig
import dev.crazyagent.remote.data.StreamSignal
import dev.crazyagent.remote.data.array
import dev.crazyagent.remote.data.bool
import dev.crazyagent.remote.data.eventStream
import dev.crazyagent.remote.data.obj
import dev.crazyagent.remote.data.string
import dev.crazyagent.remote.notifications.PushMessage
import dev.crazyagent.remote.notifications.PushState
import dev.crazyagent.remote.state.ChatReducer
import dev.crazyagent.remote.state.ChatState
import dev.crazyagent.remote.state.ResyncReason
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import java.util.UUID

enum class LinkStatus {
    /** Not connected because the app is in the background. */
    PAUSED,
    CONNECTING,
    LIVE,
    RECONNECTING,

    /** The token was rejected or revoked; needs re-pairing. Never retried automatically. */
    AUTH_FAILED,

    /** The server refused this host name or has no remote API at this address. */
    HOST_REJECTED,
}

data class LinkState(val status: LinkStatus = LinkStatus.PAUSED, val detail: String? = null, val retryInMs: Long? = null)

enum class PendingPhase {
    SENDING,
    UNCERTAIN,
    NEEDS_REVIEW,

    /** Accepted as a steer: the running turn is stopping and this message starts next. */
    STEERING,
}

/** The single prompt whose acceptance is not yet confirmed by the companion. */
data class PendingPrompt(
    val clientMessageId: String,
    val text: String,
    val images: List<PromptImage>,
    val imageCount: Int,
    val instanceId: String?,
    val phase: PendingPhase,
    val note: String? = null,
    val planMode: Boolean = false,
    val steer: Boolean = false,
)

data class ArchivedChat(
    val sessionId: String,
    val title: String,
    val updatedAt: String,
    val items: List<dev.crazyagent.remote.state.ChatItem>,
)

/** The decoded-on-demand bytes of the screenshot shown in the live view. */
class LiveImage(val id: String, val bytes: ByteArray, val width: Int?, val height: Int?) {
    override fun toString(): String = "LiveImage($id, ${bytes.size} bytes)"
}

data class UiState(
    val host: String,
    val chat: ChatState = ChatState(),
    val link: LinkState = LinkState(),
    val composer: String = "",
    val attachments: List<PromptImage> = emptyList(),
    val pending: PendingPrompt? = null,
    val stopInFlight: Boolean = false,
    val newInFlight: Boolean = false,
    val resumeInFlight: Boolean = false,
    val historyLoading: Boolean = false,
    val historyOpen: ArchivedChat? = null,
    val planMode: Boolean = false,
    val notice: String? = null,
    /** Last screenshot that finished downloading; kept while a newer one loads. */
    val liveImage: LiveImage? = null,
    /** A screenshot the companion no longer has (evicted) or that could not be fetched. */
    val liveImageMissingId: String? = null,
    val snapshotInFlight: Boolean = false,
    val push: PushState = PushState(),
) {
    /** The newest screenshot cannot be shown; an older one may still be on screen. */
    val liveImageUnavailable: Boolean get() = chat.screenshot != null && chat.screenshot.id == liveImageMissingId
    /** A newer screenshot than the one on screen is still downloading. */
    val liveImageLoading: Boolean get() = chat.screenshot != null && chat.screenshot.id != liveImage?.id && !liveImageUnavailable
    /** Metadata of the image actually on screen (it can lag behind the newest one). */
    val liveImageMeta: dev.crazyagent.remote.state.Screenshot? get() = chat.screenshot?.takeIf { it.id == liveImage?.id }
    /**
     * A fresh capture is possible only between turns with the side panel
     * connected; while the agent works its own latest view is shown instead.
     */
    val canCapture: Boolean
        get() = link.status == LinkStatus.LIVE && chat.synced && !busy && !snapshotInFlight && chat.health.uiConnected != false
    val runtimeReady: Boolean get() = chat.health.dsh == null || chat.health.dsh == "ready"
    val busy: Boolean get() = chat.turn.isActive
    val canSend: Boolean
        get() = link.status == LinkStatus.LIVE && chat.synced && pending == null && !busy && runtimeReady && composer.isNotBlank()
    /** Redirect the running turn: it is stopped and this message runs next. */
    val canSteer: Boolean
        get() = link.status == LinkStatus.LIVE && chat.synced && pending == null && busy && runtimeReady && composer.isNotBlank()
    val canStop: Boolean get() = link.status == LinkStatus.LIVE && busy && chat.turn.status != "stopping" && !stopInFlight
    val canStartNew: Boolean get() = link.status == LinkStatus.LIVE && chat.synced && !busy && !newInFlight && !resumeInFlight && pending == null
}

/**
 * Owns one paired connection: the `/events` stream with replay/resync and
 * bounded reconnect, plus send/stop/new with client-generated IDs.
 *
 * Rules (`docs/REMOTE-ACCESS.md` §4.5, §13.4):
 * - an uncertain send is reconciled with `/state` and retried only with the
 *   **same** ID; a new ID is generated only by a deliberate user resend;
 * - after a companion restart an uncertain send needs user review;
 * - a rejected or revoked token stops reconnecting until the user acts.
 */
class RemoteController(
    private val config: ServerConfig,
    private val client: OkHttpClient,
    private val pendingStore: PendingStore,
    private val scope: CoroutineScope,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val random: () -> Double = { Math.random() },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val maxAutoRetries: Int = 3,
) {
    private val api = RemoteApi(client, config)
    private val _state = MutableStateFlow(UiState(host = config.displayHost))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val wakeups = Channel<Unit>(Channel.CONFLATED)
    private val deliveryLock = Mutex()
    private var reconcileJob: Job? = null
    private var forceResync = false
    private var stopCommandId: String? = null
    private var newCommandId: String? = null
    private var resumeCommand: Pair<String, String>? = null
    private var snapshotCommandId: String? = null
    /** A tapped notification waiting for the next full resync to be checked against. */
    private var openedFrom: PushMessage? = null
    private var imageJob: Job? = null
    private var imageJobId: String? = null
    /** A screenshot that could not be fetched; not retried until the stream reopens. */
    private var imageFailedId: String? = null

    /** Restore a pending prompt that survived process death. Call once before [run]. */
    suspend fun restore() {
        val stored = pendingStore.load() ?: return
        _state.update {
            it.copy(pending = PendingPrompt(
                clientMessageId = stored.clientMessageId,
                text = stored.text,
                images = emptyList(),
                imageCount = stored.imageCount,
                instanceId = stored.instanceId,
                phase = PendingPhase.UNCERTAIN,
                note = "Checking whether this message reached the companion…",
                planMode = stored.planMode,
                steer = stored.steer,
            ))
        }
        scheduleReconcile()
    }

    // ---- composer -------------------------------------------------------

    fun updateComposer(text: String) = _state.update { it.copy(composer = text) }

    fun togglePlanMode() = _state.update {
        it.copy(planMode = !it.planMode, notice = if (it.planMode) "Plan mode canceled" else "Plan mode armed for the next turn")
    }

    fun addImages(images: List<PromptImage>) = _state.update { it.copy(attachments = (it.attachments + images).take(MAX_IMAGES)) }

    fun removeImage(index: Int) = _state.update { it.copy(attachments = it.attachments.filterIndexed { i, _ -> i != index }) }

    fun dismissNotice() = _state.update { it.copy(notice = null) }

    fun noticeFromUi(message: String) = notice(message)

    fun refreshSessions() {
        scope.launch {
            val result = api.sessions()
            if (result is ApiResult.Ok) {
                _state.update { it.copy(chat = it.chat.copy(sessions = ChatReducer.sessionsOf(result.body))) }
            }
        }
    }

    fun openHistory(sessionId: String) {
        if (_state.value.historyLoading || !Regex("^[A-Za-z0-9_-]{1,128}$").matches(sessionId)) return
        _state.update { it.copy(historyLoading = true) }
        scope.launch {
            when (val result = api.session(sessionId)) {
                is ApiResult.Ok -> _state.update {
                    it.copy(
                        historyLoading = false,
                        historyOpen = ArchivedChat(
                            sessionId = sessionId,
                            title = result.body.string("title") ?: "Saved chat",
                            updatedAt = result.body.string("updatedAt").orEmpty(),
                            items = ChatReducer.archivedItems(result.body),
                        ),
                    )
                }
                is ApiResult.Rejected -> _state.update { it.copy(historyLoading = false, notice = result.message) }
                is ApiResult.Unreachable -> _state.update { it.copy(historyLoading = false, notice = result.reason) }
            }
        }
    }

    fun closeHistory() = _state.update { it.copy(historyOpen = null, historyLoading = false) }

    // ---- commands -------------------------------------------------------

    fun send() {
        var created: PendingPrompt? = null
        _state.update { current ->
            if (!current.canSend && !current.canSteer) return@update current
            val prompt = PendingPrompt(
                clientMessageId = newId(),
                text = current.composer.trim(),
                images = current.attachments,
                imageCount = current.attachments.size,
                instanceId = current.chat.instanceId,
                phase = PendingPhase.SENDING,
                planMode = current.planMode,
                steer = current.busy,
            )
            created = prompt
            current.copy(composer = "", attachments = emptyList(), pending = prompt, planMode = false, notice = null)
        }
        val prompt = created ?: return
        scope.launch {
            pendingStore.save(StoredPending(prompt.clientMessageId, prompt.text, prompt.imageCount, prompt.instanceId, prompt.planMode, prompt.steer))
            deliver(prompt)
        }
    }

    /** User-initiated retry of a pending prompt with its original ID. */
    fun retryPending() {
        val pending = _state.value.pending ?: return
        if (pending.phase != PendingPhase.NEEDS_REVIEW) return
        if (pending.imageCount > pending.images.size || pending.instanceId != _state.value.chat.instanceId) {
            _state.update { it.copy(notice = "This message can't be retried as-is. Use Send again or Edit.") }
            return
        }
        _state.update { it.copy(pending = pending.copy(phase = PendingPhase.SENDING, note = null)) }
        scope.launch { deliver(pending) }
    }

    /** Deliberate resend as a new message (new ID), after the user reviewed the chat. */
    fun resendPendingAsNew() {
        val pending = _state.value.pending ?: return
        if (pending.phase != PendingPhase.NEEDS_REVIEW) return
        editPending()
        send()
    }

    /** Move a reviewed pending prompt back into the composer without sending. */
    fun editPending() {
        val pending = _state.value.pending ?: return
        if (pending.phase != PendingPhase.NEEDS_REVIEW) return
        reconcileJob?.cancel()
        _state.update { it.copy(pending = null, composer = pending.text, attachments = pending.images, planMode = it.planMode || pending.planMode) }
        scope.launch { pendingStore.clear() }
    }

    fun discardPending() {
        val pending = _state.value.pending ?: return
        if (pending.phase != PendingPhase.NEEDS_REVIEW) return
        reconcileJob?.cancel()
        _state.update { it.copy(pending = null) }
        scope.launch { pendingStore.clear() }
    }

    fun stop() {
        if (!_state.value.canStop) return
        val id = stopCommandId ?: newId().also { stopCommandId = it }
        _state.update { it.copy(stopInFlight = true) }
        scope.launch {
            val result = api.stop(id)
            _state.update { it.copy(stopInFlight = false) }
            when (result) {
                is ApiResult.Ok -> stopCommandId = null
                is ApiResult.Rejected -> {
                    stopCommandId = null
                    onRejected(result)
                }
                // Keep the ID so tapping Stop again repeats the same command.
                is ApiResult.Unreachable -> notice("Stop was not confirmed. ${result.reason}")
            }
        }
    }

    fun newChat() {
        if (!_state.value.canStartNew) return
        val id = newCommandId ?: newId().also { newCommandId = it }
        _state.update { it.copy(newInFlight = true) }
        scope.launch {
            val result = api.newChat(id)
            _state.update { it.copy(newInFlight = false) }
            when (result) {
                is ApiResult.Ok -> newCommandId = null
                is ApiResult.Rejected -> {
                    newCommandId = null
                    onRejected(result)
                }
                is ApiResult.Unreachable -> notice("New chat was not confirmed. ${result.reason}")
            }
        }
    }

    /**
     * Continue a saved chat: the companion switches its session and the stream
     * then resyncs with that chat's messages. Refused while a turn runs.
     */
    fun resumeChat(sessionId: String) {
        if (!_state.value.canStartNew || !Regex("^[A-Za-z0-9_-]{1,128}$").matches(sessionId)) return
        val id = resumeCommand?.takeIf { it.first == sessionId }?.second ?: newId().also { resumeCommand = sessionId to it }
        _state.update { it.copy(resumeInFlight = true) }
        scope.launch {
            val result = api.resumeSession(sessionId, id)
            // One update on success, so the saved-chat sheet never shows a finished Continue.
            _state.update {
                if (result is ApiResult.Ok) it.copy(resumeInFlight = false, historyOpen = null, historyLoading = false, notice = "Continuing this chat. Your next message picks it up.")
                else it.copy(resumeInFlight = false)
            }
            when (result) {
                is ApiResult.Ok -> {
                    resumeCommand = null
                    refreshSessions()
                }
                is ApiResult.Rejected -> {
                    resumeCommand = null
                    onRejected(result)
                }
                // Keep the ID so tapping again repeats the same command.
                is ApiResult.Unreachable -> notice("Continue was not confirmed. ${result.reason}")
            }
        }
    }

    /**
     * Ask for one fresh screenshot. The image itself arrives on the event
     * stream like any other; a 2xx here is not proof of anything on the page.
     */
    fun captureScreen() {
        if (!_state.value.canCapture) return
        val id = snapshotCommandId ?: newId().also { snapshotCommandId = it }
        _state.update { it.copy(snapshotInFlight = true) }
        scope.launch {
            val result = api.snapshot(id)
            _state.update { it.copy(snapshotInFlight = false) }
            when (result) {
                is ApiResult.Ok -> snapshotCommandId = null
                is ApiResult.Rejected -> {
                    snapshotCommandId = null
                    onRejected(result)
                }
                // Keep the ID so tapping again repeats the same command.
                is ApiResult.Unreachable -> notice("The screenshot was not confirmed. ${result.reason}")
            }
        }
    }

    // ---- push ----------------------------------------------------------

    fun setPushState(push: PushState) = _state.update { it.copy(push = push) }

    /**
     * Give the companion this phone's FCM token. "Registered" means the
     * companion stored it, not that a notification will reach this phone.
     */
    suspend fun registerPush(deviceId: String, fcmToken: String, appVersion: String) {
        setPushState(PushState(PushState.Status.REGISTERING))
        val next = when (val result = api.registerPush(deviceId, fcmToken, appVersion)) {
            is ApiResult.Ok -> PushState(PushState.Status.REGISTERED)
            is ApiResult.Rejected -> when {
                result.code == "PUSH_NOT_CONFIGURED" || result.code == "NOT_IMPLEMENTED" ->
                    PushState(PushState.Status.OFF_ON_COMPUTER, "The computer has no Firebase key, so it cannot send notifications.")
                result.status == 401 -> {
                    onRejected(result)
                    PushState(PushState.Status.FAILED, "The token was rejected.")
                }
                else -> PushState(PushState.Status.FAILED, result.message)
            }
            is ApiResult.Unreachable -> PushState(PushState.Status.FAILED, result.reason)
        }
        setPushState(next)
    }

    /** Best effort when this pairing is forgotten; a lost phone is revoked on the computer instead. */
    suspend fun unregisterPush(deviceId: String) {
        api.unregisterPush(deviceId)
    }

    /**
     * The app was opened from a notification. Reconnect with a full resync so
     * what is shown is the companion's current state, and say so when the
     * notification came from a companion run that no longer exists.
     */
    fun openedFromNotification(message: PushMessage) {
        openedFrom = message
        forceResync = true
        nudge()
    }

    /** Stop background reconciliation when this pairing is replaced or forgotten. */
    fun close() {
        reconcileJob?.cancel()
        imageJob?.cancel()
    }

    /** Reconnect now instead of waiting out the backoff (network change, Retry button). */
    fun nudge() {
        wakeups.trySend(Unit)
    }

    // ---- connection loop ------------------------------------------------

    /**
     * Keep `/events` connected until cancelled (the app leaves the foreground).
     * Each connection resumes from the last applied sequence when possible.
     */
    suspend fun run() {
        var attempt = 0
        try {
            while (true) {
                val link = _state.value.link.status
                if (link == LinkStatus.AUTH_FAILED || link == LinkStatus.HOST_REJECTED) {
                    wakeups.receive()
                }
                setLink(if (attempt == 0) LinkStatus.CONNECTING else LinkStatus.RECONNECTING, _state.value.link.detail)
                val chat = _state.value.chat
                val resume = chat.synced && !forceResync
                forceResync = false
                val request = api.eventsRequest(if (resume) chat.instanceId else null, if (resume) chat.lastSeq else null)
                var outcome: LinkState? = null
                var sawFrame = false
                client.eventStream(request).takeWhile { signal ->
                    when (signal) {
                        StreamSignal.Opened -> {
                            imageFailedId = null
                            _state.update { it.copy(liveImageMissingId = null) }
                            setLink(LinkStatus.LIVE, null)
                            true
                        }
                        is StreamSignal.Frame -> {
                            sawFrame = true
                            applyFrame(signal.json)
                        }
                        StreamSignal.Malformed -> {
                            _state.update { it.copy(chat = it.chat.copy(malformedFrames = it.chat.malformedFrames + 1)) }
                            true
                        }
                        is StreamSignal.Closed -> {
                            outcome = closedState(signal.code, signal.reason)
                            false
                        }
                        is StreamSignal.Failed -> {
                            outcome = failedState(signal)
                            false
                        }
                    }
                }.collect {}
                if (sawFrame) attempt = 0
                val next = outcome
                if (next != null && (next.status == LinkStatus.AUTH_FAILED || next.status == LinkStatus.HOST_REJECTED)) {
                    _state.update { it.copy(link = next) }
                    continue
                }
                if (forceResync) continue // reconnect immediately for a full resync
                val wait = Backoff.delayMs(attempt, random())
                attempt += 1
                _state.update { it.copy(link = LinkState(LinkStatus.RECONNECTING, next?.detail ?: "Connection closed.", wait)) }
                withTimeoutOrNull(wait) { wakeups.receive() }
            }
        } finally {
            _state.update { if (it.link.status == LinkStatus.AUTH_FAILED || it.link.status == LinkStatus.HOST_REJECTED) it else it.copy(link = LinkState(LinkStatus.PAUSED)) }
        }
    }

    /** @return false to drop the stream and resync. */
    private fun applyFrame(frame: JsonObject): Boolean {
        val before = _state.value.chat
        val reduction = ChatReducer.reduce(before, frame)
        val restarted = reduction.resynced == "instance-changed" ||
            (reduction.resynced != null && before.instanceId != null && reduction.state.instanceId != before.instanceId)
        _state.update {
            it.copy(
                chat = reduction.state,
                notice = if (restarted) "The companion restarted. Messages from before the restart are no longer available." else it.notice,
            )
        }
        val opened = openedFrom
        if (opened != null && reduction.resynced != null) {
            openedFrom = null
            if (reduction.state.instanceId != opened.instanceId) {
                _state.update { it.copy(notice = "The companion restarted after that notification. This is its current chat.") }
            } else if (reduction.state.lastSeq < opened.sequence) {
                _state.update { it.copy(notice = "That notification is newer than what the companion reports. Pull the latest by reconnecting.") }
            }
        }
        val type = frame.string("type")
        if (type == "chat.session" || type == "chat.turn") refreshSessions()
        syncLiveImage()
        val pending = _state.value.pending
        if (pending != null && pending.phase != PendingPhase.SENDING && reduction.state.hasUserMessage(pending.clientMessageId)) {
            accepted(pending)
        } else if (reduction.resynced != null && pending?.phase == PendingPhase.UNCERTAIN) {
            scheduleReconcile()
        } else if (reduction.resynced != null && pending?.phase == PendingPhase.STEERING && !reduction.state.turn.isActive) {
            // The old turn is over and the steering message never started.
            needsReview(pending, "The steering message did not start. Check the chat, then send again or discard.")
        }
        if (reduction.resync != null) {
            forceResync = true
            if (reduction.resync == ResyncReason.INSTANCE_CHANGED) {
                _state.update { it.copy(chat = it.chat.copy(synced = false)) }
            }
            return false
        }
        return true
    }

    /**
     * Download the newest screenshot, latest wins: a newer ID cancels an
     * older download, and the previous image stays up until the new one is in.
     */
    private fun syncLiveImage() {
        val wanted = _state.value.chat.screenshot
        if (wanted == null) {
            imageJob?.cancel()
            imageJobId = null
            _state.update { if (it.chat.screenshot == null && it.liveImage != null) it.copy(liveImage = null) else it }
            return
        }
        if (_state.value.liveImage?.id == wanted.id || imageFailedId == wanted.id) return
        if (imageJobId == wanted.id && imageJob?.isActive == true) return
        imageJob?.cancel()
        imageJobId = wanted.id
        imageJob = scope.launch {
            for (attempt in 0 until IMAGE_ATTEMPTS) {
                if (attempt > 0) sleep(Backoff.delayMs(attempt - 1, random()))
                val bytes = api.screenshot(wanted.id) ?: continue
                _state.update {
                    if (it.chat.screenshot?.id == wanted.id) it.copy(liveImage = LiveImage(wanted.id, bytes, wanted.width, wanted.height)) else it
                }
                return@launch
            }
            imageFailedId = wanted.id
            _state.update { if (it.chat.screenshot?.id == wanted.id) it.copy(liveImageMissingId = wanted.id) else it }
        }
    }

    private fun closedState(code: Int, reason: String): LinkState = when (code) {
        CloseCodes.TOKEN_REVOKED -> LinkState(LinkStatus.AUTH_FAILED, "The companion revoked this token. Pair again with the new token.")
        CloseCodes.GOING_AWAY -> LinkState(LinkStatus.RECONNECTING, "The companion is shutting down.")
        CloseCodes.TRY_AGAIN_LATER -> LinkState(LinkStatus.RECONNECTING, "The connection fell behind; catching up.")
        else -> LinkState(LinkStatus.RECONNECTING, reason.ifEmpty { "Connection closed ($code)." })
    }

    private fun failedState(signal: StreamSignal.Failed): LinkState = when (signal.httpStatus) {
        401 -> LinkState(LinkStatus.AUTH_FAILED, "The token was rejected. Pair again with the token from --pair-remote.")
        421 -> LinkState(LinkStatus.HOST_REJECTED, "The companion does not accept ${config.displayHost}. Start it with --remote-public-host ${config.baseUrl.host}.")
        404 -> LinkState(LinkStatus.HOST_REJECTED, "${config.displayHost} has no crazyAgent remote API.")
        429 -> LinkState(LinkStatus.RECONNECTING, "Too many failed attempts; waiting.")
        null -> LinkState(LinkStatus.RECONNECTING, "Can't reach ${config.displayHost}. Check Tailscale and the companion.")
        else -> LinkState(LinkStatus.RECONNECTING, "The server answered HTTP ${signal.httpStatus}.")
    }

    private fun setLink(status: LinkStatus, detail: String?) = _state.update { it.copy(link = LinkState(status, detail)) }

    // ---- delivery -------------------------------------------------------

    private suspend fun deliver(prompt: PendingPrompt) = deliveryLock.withLock {
        handleSendResult(prompt, api.sendMessage(prompt.clientMessageId, prompt.text, prompt.images, prompt.planMode, prompt.steer))
    }

    private suspend fun handleSendResult(prompt: PendingPrompt, result: ApiResult) {
        when (result) {
            is ApiResult.Ok -> {
                if (result.body.bool("steered") == true && !_state.value.chat.hasUserMessage(prompt.clientMessageId)) {
                    // Accepted, but it only appears in the chat once the running turn has stopped.
                    _state.update {
                        if (it.pending?.clientMessageId != prompt.clientMessageId) it
                        else it.copy(pending = prompt.copy(phase = PendingPhase.STEERING, note = "Stopping the current turn…"))
                    }
                    if (_state.value.chat.hasUserMessage(prompt.clientMessageId)) accepted(prompt)
                } else {
                    accepted(prompt)
                }
            }
            is ApiResult.Rejected -> {
                if (result.code == "IDEMPOTENCY_CONFLICT") {
                    needsReview(prompt, "The companion has a different message under this ID. Check the chat.")
                    return
                }
                rejected(prompt, result)
            }
            is ApiResult.Unreachable -> {
                if (!result.mayHaveArrived) {
                    rejectedLocally(prompt, "Not sent. ${result.reason}")
                } else {
                    _state.update { it.copy(pending = prompt.copy(phase = PendingPhase.UNCERTAIN, note = "Not confirmed yet. ${result.reason}")) }
                    scheduleReconcile()
                }
            }
        }
    }

    private fun scheduleReconcile() {
        if (reconcileJob?.isActive == true) return
        reconcileJob = scope.launch { reconcile() }
    }

    /** Query `/state`; retry only with the same ID while the companion instance is unchanged. */
    private suspend fun reconcile() {
        var attempt = 0
        while (true) {
            val pending = _state.value.pending ?: return
            if (pending.phase != PendingPhase.UNCERTAIN) return
            if (_state.value.chat.hasUserMessage(pending.clientMessageId)) return accepted(pending)
            if (attempt >= maxAutoRetries) {
                return needsReview(pending, "Couldn't confirm delivery. Check the chat, then retry or discard.")
            }
            sleep(Backoff.delayMs(attempt, random()))
            attempt += 1
            val state = api.state()
            when (state) {
                is ApiResult.Ok -> {
                    val instance = state.body.string("instanceId")
                    if (pending.instanceId == null || instance != pending.instanceId) {
                        return needsReview(pending, "The companion restarted, so this message may not have run. Check the chat, then send again or discard.")
                    }
                    if (projectionHasMessage(state.body, pending.clientMessageId)) return accepted(pending)
                    if (pending.imageCount > pending.images.size) {
                        return needsReview(pending, "The app restarted before this message was confirmed, and its images are gone. Check the chat, then edit and resend or discard.")
                    }
                    deliveryLock.withLock {
                        val current = _state.value.pending
                        if (current?.clientMessageId == pending.clientMessageId && current.phase == PendingPhase.UNCERTAIN) {
                            handleSendResult(current, api.sendMessage(current.clientMessageId, current.text, current.images, current.planMode, current.steer))
                        }
                    }
                }
                is ApiResult.Rejected -> if (state.status == 401) return onRejected(state)
                is ApiResult.Unreachable -> Unit
            }
        }
    }

    private fun accepted(prompt: PendingPrompt) {
        var cleared = false
        _state.update {
            if (it.pending?.clientMessageId == prompt.clientMessageId) {
                cleared = true
                it.copy(pending = null)
            } else it
        }
        if (cleared) scope.launch { pendingStore.clear() }
    }

    private suspend fun rejected(prompt: PendingPrompt, result: ApiResult.Rejected) {
        rejectedLocally(prompt, result.message)
        if (result.status == 401) onRejected(result)
    }

    /** Definitely not running: put the prompt back in the composer. */
    private suspend fun rejectedLocally(prompt: PendingPrompt, message: String) {
        _state.update {
            if (it.pending?.clientMessageId != prompt.clientMessageId) return@update it
            it.copy(
                pending = null,
                composer = if (it.composer.isEmpty()) prompt.text else it.composer,
                attachments = if (it.attachments.isEmpty()) prompt.images else it.attachments,
                notice = message,
            )
        }
        pendingStore.clear()
    }

    private fun needsReview(prompt: PendingPrompt, note: String) {
        _state.update {
            val current = it.pending
            if (current == null || current.clientMessageId != prompt.clientMessageId) it
            else it.copy(pending = current.copy(phase = PendingPhase.NEEDS_REVIEW, note = note))
        }
    }

    private fun onRejected(result: ApiResult.Rejected) {
        if (result.status == 401) {
            _state.update { it.copy(link = LinkState(LinkStatus.AUTH_FAILED, "The token was rejected. Pair again with the token from --pair-remote.")) }
        } else {
            notice(result.message)
        }
    }

    private fun notice(message: String) = _state.update { it.copy(notice = message) }

    private fun projectionHasMessage(projection: JsonObject, clientMessageId: String): Boolean =
        projection.array("messages").orEmpty().any { element ->
            val envelope = element as? JsonObject
            envelope?.string("type") == "chat.user" && envelope.obj("body")?.string("clientMessageId") == clientMessageId
        }

    companion object {
        const val MAX_IMAGES = 4
        private const val IMAGE_ATTEMPTS = 3
    }
}
