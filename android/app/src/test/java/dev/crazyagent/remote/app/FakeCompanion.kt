package dev.crazyagent.remote.app

import dev.crazyagent.remote.data.RemoteJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A small in-JVM stand-in for the companion remote API, following the
 * Milestone 1 contract (`docs/REMOTE-ACCESS.md` §4.5.1): bearer auth,
 * idempotent client IDs, one turn slot, and `/events` replay or resync.
 * The wire format of its events is pinned separately by the RemoteHub fixtures.
 */
class FakeCompanion(var token: String, var instanceId: String = "fake-1") : Dispatcher() {
    private val lock = Any()
    private var seq = 0L
    private val journal = mutableListOf<JsonObject>()
    private val committed = mutableListOf<JsonObject>()
    private val sockets = CopyOnWriteArrayList<WebSocket>()
    private val outcomes = mutableMapOf<String, Pair<Int, JsonObject>>()
    private var turnId: String? = null
    private var turnStatus = "idle"
    private var turnCounter = 0
    private var sessionId = "session-1"

    private val screenshots = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
    @Volatile private var latestScreenshot: JsonObject? = null
    /** Every screenshot ID requested, in order. */
    val screenshotGets = CopyOnWriteArrayList<String>()
    /** Answer the next N screenshot requests with 503. */
    @Volatile var failScreenshots = 0

    private var pendingSteer: Pair<String, JsonObject>? = null
    private var help: JsonObject? = null
    val snapshotPosts = CopyOnWriteArrayList<JsonObject>()
    /** Registered push devices: device ID to the body it sent. */
    val pushDevices = java.util.concurrent.ConcurrentHashMap<String, JsonObject>()
    val pushDeletes = CopyOnWriteArrayList<String>()
    /** Whether the computer has an FCM key. */
    @Volatile var pushConfigured = true
    /** Report the side panel as disconnected. */
    @Volatile var uiConnected = true
    private val saved = mutableMapOf<String, List<JsonObject>>()
    val resumePosts = CopyOnWriteArrayList<String>()
    val unresumable = CopyOnWriteArrayList<String>()
    /** Lose a waiting steer when its turn stops (the companion could not start it). */
    @Volatile var dropPendingSteer = false

    /** Every POST /messages body, in order. */
    val messagePosts = CopyOnWriteArrayList<JsonObject>()
    val stopPosts = CopyOnWriteArrayList<JsonObject>()
    val newPosts = CopyOnWriteArrayList<JsonObject>()
    val eventRequests = CopyOnWriteArrayList<RecordedRequest>()
    val authHeaders = CopyOnWriteArrayList<String?>()

    /** Drop the next /messages response without processing it (lost on the way in). */
    @Volatile var loseNextMessage = false
    /** Process the next /messages request but drop its response (lost on the way back). */
    @Volatile var dropNextAcceptance = false
    /** Refuse the next N event upgrades with this HTTP status. */
    @Volatile var refuseUpgrades = 0
    @Volatile var refuseStatus = 503
    /** Reject prompts as busy even when idle (a desktop send won the race). */
    @Volatile var forceBusy = false
    /** Do not push live events to sockets (simulates a stalled stream). */
    @Volatile var muteLive = false

    val activeTurnId: String? get() = synchronized(lock) { turnId }

    override fun dispatch(request: RecordedRequest): MockResponse {
        authHeaders += request.headers["Authorization"]
        if (request.headers["Authorization"] != "Bearer $token") {
            return json(401, JsonObject(error("UNAUTHORIZED", "Missing or invalid remote token.")))
        }
        val path = request.url.encodedPath
        return when {
            path == "/remote/v1/state" && request.method == "GET" -> synchronized(lock) { json(200, projection()) }
            path == "/remote/v1/sessions" && request.method == "GET" -> synchronized(lock) { json(200, buildJsonObject { put("sessions", JsonArray(listOfNotNull(sessionSummary()))) }) }
            path.startsWith("/remote/v1/sessions/") && request.method == "GET" -> synchronized(lock) { transcript(path.substringAfterLast('/')) }
            path == "/remote/v1/messages" && request.method == "POST" -> postMessage(body(request))
            path.startsWith("/remote/v1/sessions/") && path.endsWith("/resume") && request.method == "POST" ->
                postResume(path.removeSuffix("/resume").substringAfterLast('/'), body(request))
            path == "/remote/v1/stop" && request.method == "POST" -> postStop(body(request))
            path == "/remote/v1/new" && request.method == "POST" -> postNew(body(request))
            path == "/remote/v1/snapshots" && request.method == "POST" -> postSnapshot(body(request))
            path.startsWith("/remote/v1/push/devices/") && request.method == "PUT" -> {
                val device = path.substringAfterLast('/')
                if (!pushConfigured) json(503, JsonObject(error("PUSH_NOT_CONFIGURED", "Push notifications are not set up on this computer.")))
                else {
                    val created = pushDevices.put(device, body(request)) == null
                    json(200, buildJsonObject { put("deviceId", device); put("registered", true); put("created", created) })
                }
            }
            path.startsWith("/remote/v1/push/devices/") && request.method == "DELETE" -> {
                val device = path.substringAfterLast('/')
                pushDeletes += device
                json(200, buildJsonObject { put("deviceId", device); put("registered", false); put("removed", pushDevices.remove(device) != null) })
            }
            path.startsWith("/remote/v1/screenshots/") && request.method == "GET" -> screenshot(path.substringAfterLast('/'))
            path == "/remote/v1/events" -> events(request)
            else -> json(404, JsonObject(error("NOT_FOUND", "Unknown route.")))
        }
    }

    private fun postMessage(body: JsonObject): MockResponse {
        messagePosts += body
        if (loseNextMessage) {
            loseNextMessage = false
            return MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
        }
        val id = body.str("clientMessageId")
        val response = synchronized(lock) {
            outcomes[id]?.let { (status, cached) -> return@synchronized json(status, JsonObject(cached + ("replayed" to JsonPrimitive(true)))) }
            val outcome: Pair<Int, JsonObject> = if (turnId != null && body["steer"] == JsonPrimitive(true) && pendingSteer == null) {
                val next = "turn-${++turnCounter}"
                pendingSteer = next to body
                if (turnStatus != "stopping") {
                    turnStatus = "stopping"
                    publish("chat.stopping", buildJsonObject { put("message", "Stopping…") }, turnId)
                }
                202 to buildJsonObject {
                    put("accepted", true); put("clientMessageId", id); put("turnId", next); put("instanceId", instanceId); put("sequence", seq); put("steered", true)
                }
            } else if (turnId != null || forceBusy) {
                409 to JsonObject(error("TURN_BUSY", "A turn is already running.") + ("clientMessageId" to JsonPrimitive(id)))
            } else {
                val turn = "turn-${++turnCounter}"
                turnId = turn
                turnStatus = "running"
                help = null
                publish("chat.user", buildJsonObject {
                    put("text", body.str("text"))
                    put("origin", "remote")
                    put("clientMessageId", id)
                    put("imageCount", (body["images"] as? JsonArray)?.size ?: 0)
                }, turn)
                202 to buildJsonObject {
                    put("accepted", true); put("clientMessageId", id); put("turnId", turn); put("instanceId", instanceId); put("sequence", seq)
                }
            }
            outcomes[id] = outcome
            json(outcome.first, outcome.second)
        }
        if (dropNextAcceptance) {
            dropNextAcceptance = false
            return MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
        }
        return response
    }

    private fun postStop(body: JsonObject): MockResponse = synchronized(lock) {
        stopPosts += body
        val id = body.str("clientCommandId")
        outcomes[id]?.let { return json(it.first, it.second) }
        val turn = turnId
        val outcome = if (turn == null) {
            200 to buildJsonObject { put("clientCommandId", id); put("state", "idle") }
        } else {
            turnStatus = "stopping"
            publish("chat.stopping", buildJsonObject { put("message", "Stopping…") }, turn)
            202 to buildJsonObject { put("clientCommandId", id); put("state", "stopping"); put("turnId", turn) }
        }
        outcomes[id] = outcome
        json(outcome.first, outcome.second)
    }

    private fun postNew(body: JsonObject): MockResponse = synchronized(lock) {
        newPosts += body
        val id = body.str("clientCommandId")
        outcomes[id]?.let { return json(it.first, it.second) }
        val outcome = if (turnId != null) {
            409 to JsonObject(error("TURN_BUSY", "A turn is already running."))
        } else {
            saved[sessionId] = committed.toList()
            sessionId = "session-${newPosts.size + 1}"
            committed.clear()
            help = null
            turnStatus = "idle"
            latestScreenshot = null
            publish("chat.session", buildJsonObject { put("sessionId", sessionId) }, null)
            200 to buildJsonObject { put("clientCommandId", id); put("sessionId", sessionId) }
        }
        outcomes[id] = outcome
        json(outcome.first, outcome.second)
    }

    private fun events(request: RecordedRequest): MockResponse {
        eventRequests += request
        if (refuseUpgrades > 0) {
            refuseUpgrades -= 1
            return json(refuseStatus, JsonObject(error("UNAVAILABLE", "Not now.")))
        }
        val instance = request.url.queryParameter("instance")
        val after = request.url.queryParameter("after")?.toLongOrNull()
        return MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(lock) {
                    val oldest = journal.firstOrNull()?.get("seq")?.jsonPrimitive?.content?.toLong()
                    val canReplay = instance == instanceId && after != null && after in 0..seq && (after == seq || (oldest != null && after >= oldest - 1))
                    if (canReplay) {
                        journal.filter { it.seqOf() > after }.forEach { webSocket.send(it.toString()) }
                    } else {
                        val reason = when {
                            instance == null -> "no-instance"
                            instance != instanceId -> "instance-changed"
                            else -> "unknown-sequence"
                        }
                        webSocket.send(buildJsonObject {
                            put("v", 1); put("instanceId", instanceId); put("seq", seq); put("type", "remote.resync"); put("sessionId", sessionId)
                            put("body", buildJsonObject { put("reason", reason); put("state", projection()) })
                        }.toString())
                    }
                    sockets += webSocket
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                sockets -= webSocket
                webSocket.close(1000, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sockets -= webSocket
            }
        }).build()
    }

    // ---- scenario controls ---------------------------------------------

    /** Stream assistant text deltas for the running turn. */
    fun draft(streamId: String, offset: Int, delta: String) = synchronized(lock) {
        publish("chat.draft", buildJsonObject { put("streamId", streamId); put("channel", "text"); put("offset", offset); put("delta", delta) }, turnId)
    }

    fun finishTurn(text: String, replacesStreamId: String? = null) = synchronized(lock) {
        val turn = turnId ?: return@synchronized
        publish("chat.assistant", buildJsonObject { put("text", text); if (replacesStreamId != null) put("replacesStreamId", replacesStreamId) }, turn)
        publish("chat.done", buildJsonObject { put("text", text) }, turn)
        endTurn(turn, "done")
    }

    /**
     * End the running turn as the companion does after agent_request_help:
     * an optional help capture, the committed answer, `remote.help`, then the
     * waiting state.
     */
    fun finishTurnNeedingHelp(category: String, reason: String, screenshotId: String? = "shot-help", text: String = "I need you.") = synchronized(lock) {
        val turn = turnId ?: return@synchronized
        if (screenshotId != null) screenshot(screenshotId, byteArrayOf(4, 2), source = "help")
        publish("chat.assistant", buildJsonObject { put("text", text) }, turn)
        publish("chat.done", buildJsonObject {
            put("text", text)
            put("help", buildJsonObject { put("category", category); put("reason", reason) })
        }, turn)
        val request = buildJsonObject {
            put("turnId", turn); put("category", category); put("reason", reason)
            put("screenshotId", screenshotId)
            put("captureError", if (screenshotId == null) "The browser side panel is not connected." else null)
            put("requestedAt", "2026-11-06T12:00:00.000Z")
        }
        help = request
        publish("remote.help", request, turn)
        turnId = null
        turnStatus = "waiting_for_user"
        publish("chat.turn", buildJsonObject { put("status", "waiting_for_user"); put("turnId", turn); put("outcome", "done") }, turn)
    }

    private fun postSnapshot(body: JsonObject): MockResponse = synchronized(lock) {
        snapshotPosts += body
        val id = body.str("clientCommandId")
        outcomes[id]?.let { return json(it.first, JsonObject(it.second + ("replayed" to JsonPrimitive(true)))) }
        val latest = latestScreenshot?.str("screenshotId")
        val outcome = when {
            turnId != null -> 409 to JsonObject(error("TURN_BUSY", "The agent is working. Showing its latest view instead.") + ("latestScreenshotId" to JsonPrimitive(latest)))
            !uiConnected -> 503 to JsonObject(error("UI_DISCONNECTED", "The browser side panel is not connected, so the screen cannot be captured."))
            else -> {
                val shot = "shot-manual-${snapshotPosts.size}"
                screenshot(shot, byteArrayOf(5, 5, 5), source = "manual")
                201 to buildJsonObject { put("clientCommandId", id); put("screenshotId", shot); put("latestScreenshotId", shot) }
            }
        }
        outcomes[id] = outcome
        json(outcome.first, outcome.second)
    }

    /** Complete a requested stop with the real lifecycle events; a waiting steer then starts. */
    fun completeStop() = synchronized(lock) {
        val turn = turnId ?: return@synchronized
        publish("chat.stopped", buildJsonObject { put("reason", "user"); put("message", "Stopped.") }, turn)
        endTurn(turn, "stopped")
        val steer = pendingSteer ?: return@synchronized
        pendingSteer = null
        if (dropPendingSteer) return@synchronized
        turnId = steer.first
        turnStatus = "running"
        publish("chat.user", buildJsonObject {
            put("text", steer.second.str("text")); put("origin", "remote"); put("clientMessageId", steer.second.str("clientMessageId")); put("imageCount", 0)
        }, steer.first)
    }

    private fun postResume(id: String, body: JsonObject): MockResponse = synchronized(lock) {
        resumePosts += id
        val commandId = body.str("clientCommandId")
        outcomes[commandId]?.let { return json(it.first, it.second) }
        val transcript = saved[id]
        val outcome = when {
            turnId != null -> 409 to JsonObject(error("TURN_BUSY", "A turn is already running."))
            transcript == null -> 404 to JsonObject(error("SESSION_NOT_FOUND", "Unknown or expired saved chat."))
            id in unresumable -> 409 to JsonObject(error("SESSION_NOT_RESUMABLE", "This chat can no longer be continued."))
            else -> {
                saved[sessionId] = committed.toList()
                sessionId = id
                committed.clear()
                committed += transcript
                publish("chat.session", buildJsonObject { put("sessionId", id); put("resumed", true); put("restoredMessages", transcript.size) }, null)
                200 to buildJsonObject { put("clientCommandId", commandId); put("sessionId", id) }
            }
        }
        outcomes[commandId] = outcome
        json(outcome.first, outcome.second)
    }

    /** Mirror one captured view: metadata on the stream, bytes behind the ID. */
    fun screenshot(id: String, bytes: ByteArray, width: Int = 1280, height: Int = 800, source: String = "tool") = synchronized(lock) {
        screenshots[id] = bytes
        val meta = buildJsonObject {
            put("screenshotId", id); put("width", width); put("height", height); put("mimeType", "image/png"); put("bytes", bytes.size)
            put("capturedAt", "2026-11-06T12:00:00.000Z"); put("source", source)
        }
        latestScreenshot = meta
        publish("remote.screenshot", meta, turnId)
    }

    /** Forget a screenshot's bytes, as the bounded mirror does when it evicts. */
    fun expireScreenshot(id: String) { screenshots.remove(id) }

    private fun screenshot(id: String): MockResponse {
        screenshotGets += id
        if (failScreenshots > 0) {
            failScreenshots -= 1
            return json(503, JsonObject(error("UNAVAILABLE", "try again")))
        }
        val bytes = screenshots[id] ?: return json(404, JsonObject(error("SCREENSHOT_NOT_FOUND", "Unknown or expired screenshot.")))
        return MockResponse.Builder().code(200).setHeader("Content-Type", "image/png").body(okio.Buffer().write(bytes)).build()
    }

    /** Publish an envelope with a skipped sequence number. */
    fun skipSequence() = synchronized(lock) { seq += 1 }

    /** End every open stream abnormally (internal error), as a network drop would. */
    fun dropStreams() = closeStreams(1011, "dropped")

    fun closeStreams(code: Int, reason: String = "") {
        for (socket in sockets) socket.close(code, reason)
        sockets.clear()
    }

    /** Simulate a companion restart: new instance, empty journal and idempotency cache. */
    fun restart(newInstance: String) {
        synchronized(lock) {
            instanceId = newInstance
            seq = 0
            journal.clear()
            committed.clear()
            outcomes.clear()
            turnId = null
            turnStatus = "idle"
            screenshots.clear()
            latestScreenshot = null
            help = null
        }
        closeStreams(1001, "shutdown")
    }

    fun userMessageCount(): Int = synchronized(lock) { committed.count { it.str("type") == "chat.user" } }

    // ---- internals ------------------------------------------------------

    private fun endTurn(turn: String, outcome: String) {
        turnId = null
        turnStatus = "idle"
        publish("chat.turn", buildJsonObject { put("status", "idle"); put("turnId", turn); put("outcome", outcome) }, turn)
    }

    private fun publish(type: String, body: JsonObject, turn: String?): JsonObject {
        seq += 1
        val envelope = buildJsonObject {
            put("v", 1); put("instanceId", instanceId); put("seq", seq); put("type", type); put("sessionId", sessionId)
            if (turn != null) put("turnId", turn)
            put("occurredAt", "2026-11-06T12:00:00.000Z")
            put("body", body)
        }
        journal += envelope
        if (type in setOf("chat.user", "chat.assistant", "chat.tool_call", "chat.tool_result", "chat.done", "chat.stopped", "chat.error")) committed += envelope
        if (!muteLive) for (socket in sockets) socket.send(envelope.toString())
        return envelope
    }

    private fun sessionSummary(): JsonObject? {
        if (committed.isEmpty()) return null
        val title = committed.firstOrNull { it.str("type") == "chat.user" }?.jsonObject?.get("body")?.jsonObject?.str("text") ?: "Untitled chat"
        return buildJsonObject {
            put("sessionId", sessionId)
            put("title", title)
            put("updatedAt", "2026-11-06T12:00:00.000Z")
            put("messageCount", committed.size)
            put("truncated", false)
            put("current", true)
            put("running", turnId != null)
        }
    }

    private fun transcript(id: String): MockResponse {
        val messages = if (id == sessionId) committed.toList() else saved[id]
        if (messages.isNullOrEmpty()) return json(404, JsonObject(error("SESSION_NOT_FOUND", "Unknown saved chat.")))
        val title = messages.firstOrNull { it.str("type") == "chat.user" }?.get("body")?.jsonObject?.str("text") ?: "Untitled chat"
        return json(200, buildJsonObject {
            put("sessionId", id)
            put("title", title)
            put("updatedAt", "2026-11-06T12:00:00.000Z")
            put("droppedMessages", 0)
            put("messages", JsonArray(messages))
        })
    }

    private fun projection(): JsonObject = buildJsonObject {
        put("protocol", 1)
        put("instanceId", instanceId)
        put("sessionId", sessionId)
        put("latestSequence", seq)
        put("turn", buildJsonObject { put("status", turnStatus); put("turnId", turnId) })
        put("phase", buildJsonObject { put("status", null as String?); put("tool", null as String?) })
        put("health", buildJsonObject {
            put("uiConnected", uiConnected); put("toolsConnected", true); put("dsh", "ready"); put("provider", "openrouter"); put("model", "fake/model")
        })
        put("messages", JsonArray(committed.toList()))
        put("draft", JsonNull)
        put("latestScreenshot", latestScreenshot ?: JsonNull)
        put("help", help ?: JsonNull)
    }

    private fun body(request: RecordedRequest): JsonObject =
        RemoteJson.parseToJsonElement(request.body?.utf8() ?: "{}").jsonObject

    private fun json(status: Int, body: JsonObject) = MockResponse.Builder()
        .code(status)
        .setHeader("Content-Type", "application/json")
        .body(body.toString())
        .build()

    private fun error(code: String, message: String): Map<String, JsonElement> =
        mapOf("error" to buildJsonObject { put("code", code); put("message", message); put("retryable", true) })

    private fun JsonObject.str(key: String): String = (this[key] as? JsonPrimitive)?.content.orEmpty()
    private fun JsonObject.seqOf(): Long = this["seq"]!!.jsonPrimitive.content.toLong()

    @Suppress("unused")
    private fun JsonElement.messages() = jsonObject["messages"]!!.jsonArray
}
