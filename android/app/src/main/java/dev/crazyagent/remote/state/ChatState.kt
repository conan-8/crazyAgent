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

    data class Done(override val key: String, override val turnId: String?, val text: String, val model: String?) : ChatItem

    data class Stopped(override val key: String, override val turnId: String?, val reason: String?, val message: String?) : ChatItem

    data class Error(override val key: String, override val turnId: String?, val message: String) : ChatItem
}

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
) {
    val isActive: Boolean get() = status == "running" || status == "stopping"

    /** The agent asked for the user; the next message continues the same chat. */
    val isWaiting: Boolean get() = status == "waiting_for_user"
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
)

/** Metadata for the newest view the agent captured; the bytes are fetched by [id]. */
data class Screenshot(
    val id: String,
    val width: Int?,
    val height: Int?,
    val mimeType: String?,
    val capturedAt: String?,
    /** `auto`/`tool` (the agent's own view), `manual` (requested from a phone), or `help`. */
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
    /** Frames that could not be understood; shown in diagnostics only. */
    val malformedFrames: Int = 0,
) {
    fun hasUserMessage(clientMessageId: String): Boolean =
        items.any { it is ChatItem.User && it.clientMessageId == clientMessageId }
}
