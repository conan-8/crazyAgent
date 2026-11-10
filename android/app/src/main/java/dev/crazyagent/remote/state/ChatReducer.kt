package dev.crazyagent.remote.state

import dev.crazyagent.remote.data.array
import dev.crazyagent.remote.data.bool
import dev.crazyagent.remote.data.int
import dev.crazyagent.remote.data.long
import dev.crazyagent.remote.data.obj
import dev.crazyagent.remote.data.string
import kotlinx.serialization.json.JsonObject

/** Result of applying one frame. [resync] asks the caller to start over with a full resync. */
data class Reduction(val state: ChatState, val resync: ResyncReason? = null, val resynced: String? = null)

enum class ResyncReason { GAP, INSTANCE_CHANGED, DRAFT_GAP, SESSION_RESTORED }

/**
 * Pure, immutable reducer for the remote event protocol (`docs/REMOTE-ACCESS.md` §4.5).
 *
 * - `remote.resync` replaces the whole projection.
 * - Sequenced envelopes are applied exactly once, in order, per instance;
 *   duplicates are ignored and a gap or instance change requests a resync.
 * - Draft deltas append at their offset; repeats are ignored and a committed
 *   event carrying `replacesStreamId` replaces the draft.
 */
object ChatReducer {

    fun reduce(state: ChatState, frame: JsonObject): Reduction {
        val type = frame.string("type") ?: return Reduction(state.malformed())
        if (type == "remote.resync") {
            val body = frame.obj("body")
            val projection = body?.obj("state") ?: return Reduction(state.malformed())
            return Reduction(fromProjection(projection, fallbackSeq = frame.long("seq")) ?: return Reduction(state.malformed()), resynced = body.string("reason"))
        }
        val instance = frame.string("instanceId")
        val seq = frame.long("seq")
        if (instance == null || seq == null) return Reduction(state.malformed())
        if (!state.synced) return Reduction(state, ResyncReason.GAP)
        if (instance != state.instanceId) return Reduction(state, ResyncReason.INSTANCE_CHANGED)
        if (seq <= state.lastSeq) return Reduction(state)
        if (seq != state.lastSeq + 1) return Reduction(state, ResyncReason.GAP)

        val advanced = state.copy(lastSeq = seq, sessionId = frame.string("sessionId") ?: state.sessionId)
        return applyEvent(advanced, type, frame)
    }

    fun sessionsOf(body: JsonObject): List<SessionSummary> = body.array("sessions").orEmpty().mapNotNull { element ->
        val summary = element as? JsonObject ?: return@mapNotNull null
        val sessionId = summary.string("sessionId") ?: return@mapNotNull null
        SessionSummary(
            sessionId = sessionId,
            title = summary.string("title")?.ifEmpty { null } ?: "Untitled chat",
            updatedAt = summary.string("updatedAt").orEmpty(),
            messageCount = summary.int("messageCount") ?: 0,
            truncated = summary.bool("truncated") == true,
            current = summary.bool("current") == true,
            running = summary.bool("running") == true,
        )
    }

    fun archivedItems(transcript: JsonObject): List<ChatItem> {
        var state = ChatState()
        for (element in transcript.array("messages").orEmpty()) {
            val envelope = element as? JsonObject ?: continue
            val type = envelope.string("type") ?: continue
            state = applyEvent(state, type, envelope).state
        }
        return state.items
    }

    /** Build state from a `/state` body or a `remote.resync` projection. */
    fun fromProjection(projection: JsonObject, fallbackSeq: Long? = null): ChatState? {
        val instance = projection.string("instanceId") ?: return null
        val latest = projection.long("latestSequence") ?: fallbackSeq ?: return null
        var state = ChatState(
            instanceId = instance,
            lastSeq = latest,
            synced = true,
            sessionId = projection.string("sessionId"),
            turn = projection.obj("turn")?.let(::turnOf) ?: TurnInfo(),
            phase = projection.obj("phase")?.let { Phase(it.string("status"), it.string("tool")) } ?: Phase(),
            health = projection.obj("health")?.let(::healthOf) ?: Health(),
            screenshot = projection.obj("latestScreenshot")?.let(::screenshotOf),
        )
        val help = projection.obj("help")?.let(::helpOf)
        for (element in projection.array("messages").orEmpty()) {
            val envelope = element as? JsonObject ?: continue
            val type = envelope.string("type") ?: continue
            state = applyEvent(state, type, envelope).state
        }
        // Re-apply the authoritative turn after committed messages (chat.user sets running).
        state = state.copy(turn = projection.obj("turn")?.let(::turnOf) ?: state.turn)
        state = state.copy(draft = projection.obj("draft")?.let(::draftOf), help = help)
        return state
    }

    private fun applyEvent(state: ChatState, type: String, envelope: JsonObject): Reduction {
        val body = envelope.obj("body") ?: JsonObject(emptyMap())
        val key = "${envelope.string("instanceId")}:${envelope.long("seq")}"
        val turnId = envelope.string("turnId")
        val replaces = body.string("replacesStreamId")
        fun withoutDraft(s: ChatState) = if (replaces != null && s.draft?.streamId == replaces) s.copy(draft = null) else s

        val next = when (type) {
            "chat.user" -> {
                val item = ChatItem.User(
                    key, turnId,
                    text = body.string("text").orEmpty(),
                    origin = body.string("origin"),
                    clientMessageId = body.string("clientMessageId"),
                    imageCount = (body.int("imageCount") ?: 0).coerceIn(0, 4),
                )
                state.copy(
                    items = state.items + item,
                    draft = null,
                    phase = Phase(),
                    turn = TurnInfo(status = "running", turnId = turnId, origin = item.origin, clientMessageId = item.clientMessageId),
                    // Any prompt answers an open help request.
                    help = null,
                )
            }
            "chat.assistant" -> {
                val text = body.string("text").orEmpty()
                if (text.isEmpty()) withoutDraft(state) else withoutDraft(state).copy(items = state.items + ChatItem.Assistant(key, turnId, text))
            }
            "chat.tool_call" -> withoutDraft(state).copy(
                items = state.items + ChatItem.ToolCall(key, turnId, body.string("callId"), body.string("name"), body.string("args").orEmpty(), null),
            )
            "chat.tool_result" -> attachToolResult(state, key, turnId, body)
            "chat.done" -> state.copy(
                items = state.items + ChatItem.Done(
                    key, turnId,
                    text = body.string("text").orEmpty(),
                    model = body.string("model"),
                    usage = usageOf(body),
                ),
                draft = null,
                phase = Phase(),
            )
            "chat.stopped" -> {
                val timings = body.obj("timings")
                state.copy(
                    items = state.items + ChatItem.Stopped(
                        key, turnId,
                        reason = body.string("reason"),
                        message = body.string("message"),
                        usage = usageOf(body),
                        elapsedMs = timings?.long("totalMs"),
                        failedCalls = timings?.int("failedCalls"),
                    ),
                    draft = null,
                    phase = Phase(),
                )
            }
            "chat.error" -> withoutDraft(state).copy(
                items = state.items + ChatItem.Error(key, turnId, body.string("message").orEmpty().ifEmpty { "The turn failed." }),
            )
            "chat.stopping" -> state.copy(turn = if (state.turn.status == "running") state.turn.copy(status = "stopping") else state.turn)
            "chat.status" -> state.copy(
                phase = Phase(body.string("status"), body.string("tool")),
                turn = body.string("turnStatus")?.let { state.turn.copy(status = it) } ?: state.turn,
            )
            "chat.turn" -> state.copy(turn = turnOf(body), phase = Phase(), draft = null)
            "chat.session" -> state.copy(
                sessionId = body.string("sessionId") ?: state.sessionId,
                items = emptyList(),
                draft = null,
                health = state.health.copy(contextTokens = null),
                screenshot = null,
                help = null,
                turn = if (state.turn.isWaiting) state.turn.copy(status = "idle") else state.turn,
            )
            "remote.help" -> state.copy(help = helpOf(body) ?: state.help)
            "remote.screenshot" -> state.copy(screenshot = screenshotOf(body) ?: state.screenshot)
            "remote.health" -> state.copy(health = healthOf(body))
            "chat.draft" -> return applyDraft(state, turnId, body)
            // Unknown event types still advance the sequence.
            else -> state
        }
        // A continued saved chat: its earlier messages exist only in the projection.
        if (type == "chat.session" && body.bool("resumed") == true && (body.int("restoredMessages") ?: 0) > 0) {
            return Reduction(next, ResyncReason.SESSION_RESTORED)
        }
        return Reduction(next)
    }

    private fun attachToolResult(state: ChatState, key: String, turnId: String?, body: JsonObject): ChatState {
        val callId = body.string("callId")
        val result = ToolResult(body.bool("ok") == true, body.string("text").orEmpty())
        val index = state.items.indexOfLast { it is ChatItem.ToolCall && it.callId == callId && it.result == null }
        if (index < 0) {
            return state.copy(items = state.items + ChatItem.ToolCall(key, turnId, callId, null, "", result))
        }
        val items = state.items.toMutableList()
        items[index] = (items[index] as ChatItem.ToolCall).copy(result = result)
        return state.copy(items = items)
    }

    private fun applyDraft(state: ChatState, turnId: String?, body: JsonObject): Reduction {
        val streamId = body.string("streamId") ?: return Reduction(state.malformed())
        val channel = body.string("channel")
        val offset = body.int("offset") ?: return Reduction(state.malformed())
        val delta = body.string("delta").orEmpty()
        val current = state.draft?.takeIf { it.streamId == streamId } ?: Draft(streamId, turnId)

        fun merge(existing: String): String? = when {
            offset == existing.length -> existing + delta
            offset + delta.length <= existing.length -> existing // already applied
            else -> null // a gap; the aggregated draft is out of step
        }

        val updated = when (channel) {
            "text" -> merge(current.text)?.let { current.copy(text = it) }
            "reasoning" -> merge(current.reasoning)?.let { current.copy(reasoning = it) }
            "tool" -> {
                val id = body.string("toolCallId") ?: "tool"
                val tool = current.tools.firstOrNull { it.id == id } ?: DraftTool(id, body.string("name"), "")
                merge(tool.args)?.let { args ->
                    val replaced = tool.copy(args = args, name = tool.name ?: body.string("name"))
                    current.copy(tools = if (current.tools.any { it.id == id }) current.tools.map { if (it.id == id) replaced else it } else current.tools + replaced)
                }
            }
            else -> current
        } ?: return Reduction(state, ResyncReason.DRAFT_GAP)
        return Reduction(state.copy(draft = updated))
    }

    /**
     * Token usage on `chat.done`/`chat.stopped` bodies. An absent, null, or
     * wholly foreign-typed object is null so older frames and future shapes
     * never fabricate a count.
     */
    private fun usageOf(body: JsonObject): TurnUsage? {
        val usage = body.obj("usage") ?: return null
        val parsed = TurnUsage(
            inputTokens = usage.long("inputTokens"),
            outputTokens = usage.long("outputTokens"),
            totalTokens = usage.long("totalTokens"),
        )
        return parsed.takeIf { it.inputTokens != null || it.outputTokens != null || it.totalTokens != null }
    }

    private fun turnOf(body: JsonObject) = TurnInfo(
        status = body.string("status") ?: "starting",
        turnId = body.string("turnId"),
        origin = body.string("origin"),
        clientMessageId = body.string("clientMessageId"),
        outcome = body.string("outcome"),
        error = body.string("error"),
    )

    private fun healthOf(body: JsonObject) = Health(
        uiConnected = body.bool("uiConnected"),
        toolsConnected = body.bool("toolsConnected"),
        dsh = body.string("dsh"),
        dshMessage = body.string("dshMessage"),
        provider = body.string("provider"),
        model = body.string("model"),
        contextWindow = body.long("contextWindow"),
        contextTokens = body.long("contextTokens"),
        pushConfigured = body.bool("pushConfigured"),
        executorHost = body.string("executorHost"),
    )

    private fun screenshotOf(body: JsonObject): Screenshot? {
        val id = body.string("screenshotId")?.takeIf { SCREENSHOT_ID.matches(it) } ?: return null
        return Screenshot(
            id = id,
            width = body.int("width")?.takeIf { it > 0 },
            height = body.int("height")?.takeIf { it > 0 },
            mimeType = body.string("mimeType"),
            capturedAt = body.string("capturedAt"),
            source = body.string("source"),
        )
    }

    private fun helpOf(body: JsonObject): HelpRequest? {
        val reason = body.string("reason")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return HelpRequest(
            turnId = body.string("turnId"),
            category = body.string("category") ?: "other",
            reason = reason.take(500),
            screenshotId = body.string("screenshotId")?.takeIf { SCREENSHOT_ID.matches(it) },
            captureError = body.string("captureError")?.take(500),
            requestedAt = body.string("requestedAt"),
        )
    }

    /** Same shape the server accepts; the ID becomes a URL path segment. */
    private val SCREENSHOT_ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    private fun draftOf(body: JsonObject): Draft? {
        val streamId = body.string("streamId") ?: return null
        val tools = body.array("tools").orEmpty().mapNotNull { element ->
            val tool = element as? JsonObject ?: return@mapNotNull null
            DraftTool(tool.string("id") ?: return@mapNotNull null, tool.string("name"), tool.string("args").orEmpty())
        }
        return Draft(streamId, body.string("turnId"), body.string("text").orEmpty(), body.string("reasoning").orEmpty(), tools)
    }

    private fun ChatState.malformed() = copy(malformedFrames = malformedFrames + 1)
}
