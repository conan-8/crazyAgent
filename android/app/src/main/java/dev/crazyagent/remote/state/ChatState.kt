package dev.crazyagent.remote.state

/** A committed conversation entry, keyed by the companion instance and sequence. */
sealed interface ChatItem {
    val key: String
    val turnId: String?

    data class User(
        override val key: String,
        override val turnId: String?,
        val text: String,
        val origin: String?,
        val clientMessageId: String?,
        val imageCount: Int,
    ) : ChatItem

    data class Assistant(override val key: String, override val turnId: String?, val text: String) : ChatItem

    data class ToolCall(
        override val key: String,
        override val turnId: String?,
        val callId: String?,
        val name: String?,
        val args: String,
        val result: ToolResult?,
    ) : ChatItem

    data class Done(
        override val key: String,
        override val turnId: String?,
        val text: String,
        val model: String?,
        /** Tokens the companion reported for this turn; null on older frames. */
        val usage: TurnUsage? = null,
    ) : ChatItem

    data class Stopped(
        override val key: String,
        override val turnId: String?,
        val reason: String?,
        val message: String?,
        /** Partial token usage when the companion reported it; null otherwise. */
        val usage: TurnUsage? = null,
        /** How long the stopped turn had been running, from `timings.totalMs`. */
        val elapsedMs: Long? = null,
        /** Failed tool calls before the stop, from `timings.failedCalls`. */
        val failedCalls: Int? = null,
    ) : ChatItem

    data class Error(override val key: String, override val turnId: String?, val message: String) : ChatItem
}

/** Token usage the companion recorded for one turn; absent fields stay null. */
data class TurnUsage(
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val totalTokens: Long? = null,
)

data class ToolResult(val ok: Boolean, val text: String)

data class DraftTool(val id: String, val name: String?, val args: String)

/** The streamed, not-yet-committed model output for the current step. */
data class Draft(
    val streamId: String,
    val turnId: String?,
    val text: String = "",
    val reasoning: String = "",
    val tools: List<DraftTool> = emptyList(),
)

data class TurnInfo(
    val status: String = "starting",
    val turnId: String? = null,
    val origin: String? = null,
    val clientMessageId: String? = null,
    val outcome: String? = null,
    val error: String? = null,
    /** V6: the live plan while the turn runs; null at every turn boundary. */
    val plan: TurnPlan? = null,
) {
    val isActive: Boolean get() = status == "running" || status == "stopping"

    /** The agent asked for the user; the next message continues the same chat. */
    val isWaiting: Boolean get() = status == "waiting_for_user"
}

/**
 * The running turn's live checklist (V6), mirrored from `remote.plan` and the
 * `/state.turn.plan` projection. At turn end the carried plan
 * ([MarathonState.plan]) takes over, exactly as before.
 */
data class TurnPlan(
    val revision: Int,
    val items: List<MarathonPlanItem>,
    val awaitingUser: Boolean = false,
) {
    val openCount: Int get() = items.count { it.status == "pending" || it.status == "in_progress" }
}

data class Phase(val status: String? = null, val tool: String? = null)

data class Health(
    val uiConnected: Boolean? = null,
    val toolsConnected: Boolean? = null,
    val dsh: String? = null,
    val dshMessage: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val contextWindow: Long? = null,
    val contextTokens: Long? = null,
    /** Whether the computer can send pushes at all (it has an FCM key). */
    val pushConfigured: Boolean? = null,
    /** Where browser commands run: `panel`, `background`, or null when nothing is connected. */
    val executorHost: String? = null,
    /** Opt-in "ask before submitting, sending, paying, or deleting" (read-only on the phone). */
    val confirmIrreversible: Boolean? = null,
)

/** Metadata for the newest view the agent captured; the bytes are fetched by [id]. */
data class Screenshot(
    val id: String,
    val width: Int?,
    val height: Int?,
    val mimeType: String?,
    val capturedAt: String?,
    /** `auto`/`tool` (the agent's own view), `manual` (requested from a phone), `help`, or `confirm`. */
    val source: String? = null,
)

/**
 * The agent's structured request for the user, committed by the companion.
 * [screenshotId] is null when no capture could be taken; [captureError] says why.
 */
data class HelpRequest(
    val turnId: String?,
    val category: String,
    val reason: String,
    val screenshotId: String?,
    val captureError: String?,
    val requestedAt: String?,
)

/**
 * The agent's opt-in request to perform one irreversible action (B9a). The
 * companion waits for the user's Approve/Deny; the answer is sent as the next
 * message with `confirm`. The Approve/Deny card itself arrives with B9b.
 */
data class ConfirmRequest(
    val turnId: String?,
    val action: String,
    val target: String,
    val screenshotId: String?,
    val captureError: String?,
    val requestedAt: String?,
)

data class SessionSummary(
    val sessionId: String,
    val title: String,
    val updatedAt: String,
    val messageCount: Int,
    val truncated: Boolean,
    val current: Boolean,
    val running: Boolean,
)

/**
 * One plan item (live or carried); [status] is pending/in_progress/completed/
 * blocked. [reason] is the V8 optional single-line explanation, present only
 * on blocked items (why it is blocked).
 */
data class MarathonPlanItem(val content: String, val status: String, val reason: String? = null)

/**
 * The plan the companion carried out of the last marathon turn (M2). The phone
 * receives it with `remote.marathon` — its first checklist (M5).
 */
data class MarathonPlan(
    val revision: Int,
    val items: List<MarathonPlanItem>,
    val updatedAt: String,
    val turnId: String,
) {
    val openCount: Int get() = items.count { it.status == "pending" || it.status == "in_progress" }
}

/** The open watch alert exactly as the `/state` projection carries it. */
data class WatchOpen(
    val id: String,
    val kind: String,
    val at: String?,
    val reason: String,
    val steerText: String? = null,
)

/** The watcher's per-chat counters and last check (M3; verdicts arrive with M4). */
data class MarathonWatch(
    val open: WatchOpen? = null,
    val lastVerdict: String? = null,
    val lastCheckAt: String? = null,
    val checks: Int = 0,
)

/**
 * The companion-owned marathon switch, mirrored from `remote.marathon` and the
 * `/state` projection (M5). The phone renders it and never assumes or
 * optimistically flips it; off is the fail-safe default.
 */
data class MarathonState(
    val enabled: Boolean = false,
    val since: String? = null,
    val plan: MarathonPlan? = null,
    val watch: MarathonWatch = MarathonWatch(),
)

/**
 * The latest watch notice for the card above the composer. An open actionable
 * alert shows Stop / Steer… / It's fine; recovered/dismissed notices collapse
 * to a summary line. Only the open alert survives a full resync (the projection
 * carries no collapsed history), which is deliberate: the companion is
 * authoritative.
 */
data class WatchNotice(
    val id: String,
    val kind: String,
    val state: String,
    val reason: String,
    val at: String?,
    val steerText: String? = null,
) {
    /**
     * Open and actionable: the hard alert kinds, the M4 judge verdict kinds
     * (stuck/blocked), or ended-incomplete.
     */
    val actionable: Boolean
        get() = state == "open" && kind in setOf("SILENT_STALL", "TOOL_HANG", "EXECUTOR_DOWN", "stuck", "blocked", "ended-incomplete")
}

/**
 * Everything the phone knows about the companion's shared chat. Built only by
 * [ChatReducer] from `/state`, `remote.resync`, and sequenced events.
 */
data class ChatState(
    val instanceId: String? = null,
    val lastSeq: Long = 0,
    val synced: Boolean = false,
    val sessionId: String? = null,
    val items: List<ChatItem> = emptyList(),
    val draft: Draft? = null,
    val turn: TurnInfo = TurnInfo(),
    val phase: Phase = Phase(),
    val health: Health = Health(),
    val sessions: List<SessionSummary> = emptyList(),
    /** Latest screenshot of the current session, shown as the live view. */
    val screenshot: Screenshot? = null,
    /** Open only while the turn status is `waiting_for_user`. */
    val help: HelpRequest? = null,
    /** Open only while the turn status is `waiting_for_user` (B9a confirmation). */
    val confirm: ConfirmRequest? = null,
    /** The companion-owned marathon switch and its carried plan (M5). */
    val marathon: MarathonState = MarathonState(),
    /** The latest watch notice: an open alert card or its collapsed summary. */
    val watchNotice: WatchNotice? = null,
    /** Frames that could not be understood; shown in diagnostics only. */
    val malformedFrames: Int = 0,
) {
    fun hasUserMessage(clientMessageId: String): Boolean =
        items.any { it is ChatItem.User && it.clientMessageId == clientMessageId }
}
