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
        val confirm = projection.obj("confirm")?.let(::confirmOf)
        for (element in projection.array("messages").orEmpty()) {
            val envelope = element as? JsonObject ?: continue
            val type = envelope.string("type") ?: continue
            state = applyEvent(state, type, envelope).state
        }
        // Re-apply the authoritative turn and phase after committed messages
        // (chat.user sets running and clears the phase; a mid-turn resync must
        // still show what the agent is doing right now).
        state = state.copy(
            turn = projection.obj("turn")?.let(::turnOf) ?: state.turn,
            phase = projection.obj("phase")?.let { Phase(it.string("status"), it.string("tool")) } ?: state.phase,
        )
        // The marathon mirror is authoritative too: remote.marathon/remote.watch
        // are journaled but not committed messages, so the projection's block is
        // the only source for a resync (M5).
        val marathon = projection.obj("marathon")?.let(::marathonProjectionOf) ?: MarathonState()
        val watchNotice = marathon.watch.open?.let { WatchNotice(it.id, it.kind, "open", it.reason, it.at, it.steerText) }
        state = state.copy(draft = projection.obj("draft")?.let(::draftOf), help = help, confirm = confirm, marathon = marathon, watchNotice = watchNotice)
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
                    // Any prompt also answers (or abandons) an open confirmation.
                    confirm = null,
                    // A new turn keeps the open watch alert (the hub mirrors it
                    // until the watcher or an ack clears it) but drops a
                    // collapsed recovered/dismissed summary.
                    watchNotice = state.watchNotice?.takeIf { state.marathon.watch.open?.id == it.id },
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
                confirm = null,
                // The switch and any watch notice belong to the chat just left;
                // the hub resets its mirror the same way (the controller
                // publishes the authoritative off state separately).
                marathon = MarathonState(),
                watchNotice = null,
                // V6: the live plan belonged to the chat just left (hub parity).
                turn = state.turn.copy(status = if (state.turn.isWaiting) "idle" else state.turn.status, plan = null),
            )
            "remote.help" -> state.copy(help = helpOf(body) ?: state.help)
            "remote.confirm" -> state.copy(confirm = confirmOf(body) ?: state.confirm)
            "remote.marathon" -> {
                val next = marathonOf(body, state.marathon)
                // Off clears the open alert and any collapsed summary with it.
                state.copy(marathon = next, watchNotice = if (next.enabled) state.watchNotice else null)
            }
            "remote.watch" -> {
                val notice = watchNoticeOf(body)
                if (notice == null) state else {
                    // Same rule as the hub: an open notice that is neither info
                    // nor recovered is the open alert (hard kinds, judge
                    // stuck/blocked, ended-incomplete, or a future kind).
                    val open = if (notice.state == "open" && notice.kind != "info" && notice.kind != "recovered") {
                        WatchOpen(notice.id, notice.kind, notice.at, notice.reason, notice.steerText)
                    } else null
                    state.copy(watchNotice = notice, marathon = state.marathon.copy(watch = state.marathon.watch.copy(open = open)))
                }
            }
            "remote.plan" -> {
                // V6: the live checklist for the running turn. A malformed
                // envelope keeps the last good plan (fail-closed, no partial).
                val plan = turnPlanOf(body)
                if (plan == null) state else state.copy(turn = state.turn.copy(plan = plan))
            }
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
        plan = body.obj("plan")?.let(::turnPlanOf),
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
        confirmIrreversible = body.bool("confirmIrreversible"),
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

    private fun confirmOf(body: JsonObject): ConfirmRequest? {
        val action = body.string("action")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val target = body.string("target")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return ConfirmRequest(
            turnId = body.string("turnId"),
            action = action.take(200),
            target = target.take(200),
            screenshotId = body.string("screenshotId")?.takeIf { SCREENSHOT_ID.matches(it) },
            captureError = body.string("captureError")?.take(500),
            requestedAt = body.string("requestedAt"),
        )
    }

    /** Same shape the server accepts; the ID becomes a URL path segment. */
    private val SCREENSHOT_ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    /** The provider's plan item statuses (packages/dsh-browser-extension/lib/plan.js). */
    private val PLAN_STATUSES = setOf("pending", "in_progress", "completed", "blocked")

    /**
     * The carried plan, validated fail-closed exactly like the companion's
     * `normalizeMarathonPlan`: a non-negative integral revision, string
     * updatedAt/turnId, 1–40 items with non-blank unique content and a known
     * status. Anything malformed is null, never a partial plan.
     */
    private fun planOf(body: JsonObject?): MarathonPlan? {
        if (body == null) return null
        val revision = body.long("revision")?.takeIf { it >= 0 && it <= Int.MAX_VALUE } ?: return null
        val updatedAt = body.string("updatedAt") ?: return null
        val turnId = body.string("turnId") ?: return null
        val items = planItemsOf(body) ?: return null
        return MarathonPlan(revision.toInt(), items, updatedAt, turnId)
    }

    /**
     * V6: the running turn's live plan (`remote.plan` / `/state.turn.plan`).
     * Same fail-closed item rules as the carried plan; the activity carries no
     * updatedAt/turnId markers. Malformed is null — the caller keeps the last
     * good plan rather than showing a partial one.
     */
    private fun turnPlanOf(body: JsonObject): TurnPlan? {
        val revision = body.long("revision")?.takeIf { it >= 0 && it <= Int.MAX_VALUE } ?: return null
        val items = planItemsOf(body) ?: return null
        return TurnPlan(revision.toInt(), items, body.bool("awaitingUser") == true)
    }

    /**
     * The shared item-list rules: 1–40 items, non-blank unique content, known
     * status, and the V8 optional blocked-item reason — the same fail-closed
     * rules as the companion's `normalizeMarathonPlan` (any violation rejects
     * the WHOLE plan, never a partial one).
     */
    private fun planItemsOf(body: JsonObject): List<MarathonPlanItem>? {
        val items = body.array("items")?.takeIf { it.isNotEmpty() && it.size <= 40 } ?: return null
        val contents = HashSet<String>()
        return items.map { element ->
            val item = element as? JsonObject ?: return null
            val content = item.string("content")?.takeIf { it.isNotBlank() } ?: return null
            val status = item.string("status")?.takeIf { it in PLAN_STATUSES } ?: return null
            if (!contents.add(content)) return null
            // V8 (§3.9): reason is allowed ONLY on blocked items — a single
            // line (no control chars), non-blank, at most 240 chars; kept
            // trimmed. A present-but-invalid reason (including JSON null)
            // rejects the plan, exactly like the hub's validator.
            var reason: String? = null
            if (item.containsKey("reason")) {
                val raw = item.string("reason") ?: return null
                if (status != "blocked" || raw.isBlank() || raw.length > 240 || raw.any { it.code <= 0x1f || it.code == 0x7f }) return null
                reason = raw.trim()
            }
            MarathonPlanItem(content, status, reason)
        }
    }

    private fun watchChecks(body: JsonObject?): Int =
        body?.long("checks")?.takeIf { it >= 0 && it <= Int.MAX_VALUE }?.toInt() ?: 0

    /**
     * One `remote.marathon` envelope: the switch, the carried plan, and the
     * watcher counters. The open alert is tracked by `remote.watch` and
     * survives a state change, exactly like the hub's mirror; off clears
     * everything (fail-safe).
     */
    private fun marathonOf(body: JsonObject, current: MarathonState): MarathonState {
        if (body.bool("enabled") != true) return MarathonState()
        val watcher = body.obj("watcher")
        return MarathonState(
            enabled = true,
            since = body.string("since"),
            plan = planOf(body.obj("plan")),
            watch = current.watch.copy(
                checks = watchChecks(watcher),
                lastCheckAt = watcher?.string("lastCheckAt"),
                lastVerdict = watcher?.string("lastVerdict"),
            ),
        )
    }

    /** The `/state` projection's marathon block (watch.open included). */
    private fun marathonProjectionOf(body: JsonObject): MarathonState {
        val watch = body.obj("watch")
        return MarathonState(
            enabled = body.bool("enabled") == true,
            since = body.string("since"),
            plan = planOf(body.obj("plan")),
            watch = MarathonWatch(
                open = watch?.obj("open")?.let(::watchOpenOf),
                lastVerdict = watch?.string("lastVerdict"),
                lastCheckAt = watch?.string("lastCheckAt"),
                checks = watchChecks(watch),
            ),
        )
    }

    private fun watchSteerTextOf(body: JsonObject): String? =
        body.obj("steer")?.string("text")?.trim()?.takeIf { it.isNotEmpty() }?.take(300)

    private fun watchOpenOf(body: JsonObject): WatchOpen? {
        val id = body.string("id")?.takeIf { it.isNotEmpty() } ?: return null
        return WatchOpen(id, body.string("kind") ?: "info", body.string("at"), body.string("reason").orEmpty(), watchSteerTextOf(body))
    }

    /**
     * One watch notice (`remote.watch`). The card shows kind, reason, and any
     * optional watcher steer note; the projection's open alert carries the same
     * fields so a resync reconstructs the same card.
     */
    private fun watchNoticeOf(body: JsonObject): WatchNotice? {
        val id = body.string("id")?.takeIf { it.isNotEmpty() } ?: return null
        return WatchNotice(
            id = id,
            kind = body.string("kind") ?: "info",
            state = body.string("state") ?: "open",
            reason = body.string("reason").orEmpty().take(500),
            at = body.string("at"),
            steerText = watchSteerTextOf(body),
        )
    }

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
