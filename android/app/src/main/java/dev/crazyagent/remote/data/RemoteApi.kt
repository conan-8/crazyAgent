package dev.crazyagent.remote.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.util.Base64
import javax.net.ssl.SSLException
import kotlin.coroutines.resume

/** One image attached to a prompt, already validated and size-bounded. */
class PromptImage(val name: String, val mimeType: String, val bytes: ByteArray) {
    override fun toString(): String = "PromptImage($name, $mimeType, ${bytes.size} bytes)"
}

/** Outcome of one HTTP call to the remote API. */
sealed interface ApiResult {
    /** 2xx with a JSON object body. */
    data class Ok(val status: Int, val body: JsonObject) : ApiResult

    /** The server answered with a structured refusal. */
    data class Rejected(val status: Int, val code: String, val message: String, val retryable: Boolean) : ApiResult

    /**
     * No usable answer. [mayHaveArrived] is false only when the request
     * provably never reached the server (DNS, refused connection, TLS setup).
     */
    data class Unreachable(val reason: String, val mayHaveArrived: Boolean, val kind: UnreachableKind) : ApiResult
}

enum class UnreachableKind { DNS, REFUSED, TLS, TIMEOUT, NETWORK, BAD_RESPONSE }

/**
 * Authenticated client for `/remote/v1`. Every call carries
 * `Authorization: Bearer …`; the token is never logged or put in a URL.
 */
class RemoteApi(private val client: OkHttpClient, private val config: ServerConfig) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun url(path: String): HttpUrl = config.baseUrl.newBuilder()
        .addPathSegments("remote/v1")
        .addPathSegments(path)
        .build()

    suspend fun state(): ApiResult = execute(request("state").get().build())

    suspend fun sessions(): ApiResult = execute(request("sessions").get().build())

    suspend fun session(sessionId: String): ApiResult = execute(request("sessions/$sessionId").get().build())

    /**
     * Bytes of one mirrored screenshot, or null when it is gone, too large, or
     * unreachable. The caller passes only IDs the reducer already validated.
     */
    suspend fun screenshot(id: String): ByteArray? {
        val request = Request.Builder().url(url("screenshots/$id")).header("Authorization", "Bearer ${config.token}").header("Accept", "image/*").build()
        val response = try {
            client.newCall(request).await()
        } catch (_: IOException) {
            return null
        }
        return withContext(Dispatchers.IO) {
            response.use {
                if (!it.isSuccessful || it.body.contentType()?.type != "image") return@use null
                val declared = it.body.contentLength()
                if (declared > MAX_SCREENSHOT_BYTES) return@use null
                try {
                    val source = it.body.source()
                    if (source.request(MAX_SCREENSHOT_BYTES + 1)) null else source.readByteArray()
                } catch (_: IOException) {
                    null
                }
            }
        }
    }

    /** Switch the companion to a saved chat so the next message continues it. */
    suspend fun resumeSession(sessionId: String, clientCommandId: String): ApiResult =
        post("sessions/$sessionId/resume", JsonObject(mapOf("clientCommandId" to JsonPrimitive(clientCommandId))))

    /** [steer] stops a running turn and starts this message as the next one. */
    suspend fun sendMessage(clientMessageId: String, text: String, images: List<PromptImage>, planMode: Boolean = false, steer: Boolean = false): ApiResult {
        val body = JsonObject(buildMap {
            put("clientMessageId", JsonPrimitive(clientMessageId))
            put("text", JsonPrimitive(text))
            if (planMode) put("planMode", JsonPrimitive(true))
            if (steer) put("steer", JsonPrimitive(true))
            if (images.isNotEmpty()) {
                put("images", JsonArray(images.map { image ->
                    JsonObject(mapOf(
                        "name" to JsonPrimitive(image.name),
                        "mimeType" to JsonPrimitive(image.mimeType),
                        "data" to JsonPrimitive(Base64.getEncoder().encodeToString(image.bytes)),
                    ))
                }))
            }
        })
        return post("messages", body)
    }

    /** Register (or replace) this phone's FCM token for metadata-only pushes. */
    suspend fun registerPush(deviceId: String, fcmToken: String, appVersion: String): ApiResult = execute(
        request("push/devices/$deviceId").put(
            JsonObject(mapOf("fcmToken" to JsonPrimitive(fcmToken), "platform" to JsonPrimitive("android"), "appVersion" to JsonPrimitive(appVersion)))
                .toString().toRequestBody(jsonType),
        ).build(),
    )

    suspend fun unregisterPush(deviceId: String): ApiResult = execute(request("push/devices/$deviceId").delete().build())

    /** Ask the companion for one fresh view. Refused while the agent is working. */
    suspend fun snapshot(clientCommandId: String): ApiResult =
        post("snapshots", JsonObject(mapOf("clientCommandId" to JsonPrimitive(clientCommandId))))

    suspend fun stop(clientCommandId: String): ApiResult =
        post("stop", JsonObject(mapOf("clientCommandId" to JsonPrimitive(clientCommandId))))

    suspend fun newChat(clientCommandId: String): ApiResult =
        post("new", JsonObject(mapOf("clientCommandId" to JsonPrimitive(clientCommandId))))

    fun eventsRequest(instanceId: String?, after: Long?): Request {
        val builder = url("events").newBuilder()
        if (instanceId != null && after != null) {
            builder.addQueryParameter("instance", instanceId)
            builder.addQueryParameter("after", after.toString())
        }
        return Request.Builder().url(builder.build()).header("Authorization", "Bearer ${config.token}").build()
    }

    private fun request(path: String): Request.Builder =
        Request.Builder().url(url(path)).header("Authorization", "Bearer ${config.token}").header("Accept", "application/json")

    private suspend fun post(path: String, body: JsonObject): ApiResult =
        execute(request(path).post(body.toString().toRequestBody(jsonType)).build())

    private suspend fun execute(request: Request): ApiResult {
        val call = client.newCall(request)
        val response = try {
            call.await()
        } catch (error: IOException) {
            return classify(error, request.method != "GET")
        }
        return withContext(Dispatchers.IO) { response.use { read(it) } }
    }

    private fun read(response: Response): ApiResult {
        val text = try {
            response.body.string()
        } catch (error: IOException) {
            return classify(error, true)
        }
        val json = parseObject(text)
        if (response.isSuccessful) {
            return if (json != null) ApiResult.Ok(response.code, json)
            else ApiResult.Unreachable("The server sent an unreadable reply (HTTP ${response.code}).", true, UnreachableKind.BAD_RESPONSE)
        }
        val error = json?.obj("error")
        val code = error?.string("code") ?: "HTTP_${response.code}"
        val message = error?.string("message") ?: defaultMessage(response.code)
        return ApiResult.Rejected(response.code, code, message, error?.bool("retryable") == true)
    }

    private fun defaultMessage(status: Int): String = when (status) {
        401 -> "The token was rejected."
        404 -> "This server has no crazyAgent remote API. Check the address."
        421 -> "The companion does not accept this host name. Start it with --remote-public-host."
        502, 503, 504 -> "The companion is not answering behind Tailscale Serve."
        else -> "HTTP $status"
    }

    private fun classify(error: IOException, mutating: Boolean): ApiResult.Unreachable {
        val kind = when (error) {
            is UnknownHostException -> UnreachableKind.DNS
            is ConnectException, is NoRouteToHostException -> UnreachableKind.REFUSED
            is SSLException -> UnreachableKind.TLS
            is java.net.SocketTimeoutException, is java.io.InterruptedIOException -> UnreachableKind.TIMEOUT
            else -> UnreachableKind.NETWORK
        }
        // A refused/unresolved/TLS-failed connection never carried the request.
        val arrived = mutating && kind != UnreachableKind.DNS && kind != UnreachableKind.REFUSED && kind != UnreachableKind.TLS
        val reason = when (kind) {
            UnreachableKind.DNS -> "Can't find ${config.displayHost}. Is Tailscale connected on this phone?"
            UnreachableKind.REFUSED -> "${config.displayHost} refused the connection. Is the companion running with --remote?"
            UnreachableKind.TLS -> "Secure connection to ${config.displayHost} failed."
            UnreachableKind.TIMEOUT -> "${config.displayHost} did not answer in time."
            UnreachableKind.NETWORK, UnreachableKind.BAD_RESPONSE -> "The connection to ${config.displayHost} dropped."
        }
        return ApiResult.Unreachable(reason, arrived, kind)
    }
}

/** Matches the companion's per-image cap. */
private const val MAX_SCREENSHOT_BYTES = 8L * 1024 * 1024

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (continuation.isActive) continuation.resumeWith(Result.failure(e))
        }

        override fun onResponse(call: Call, response: Response) {
            if (continuation.isActive) continuation.resume(response) else response.close()
        }
    })
}
