package dev.crazyagent.remote.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** What the `/events` WebSocket reports to the controller. */
sealed interface StreamSignal {
    data object Opened : StreamSignal
    data class Frame(val json: JsonObject) : StreamSignal
    data object Malformed : StreamSignal

    /** The server closed the stream (for example 4401 revoked, 1001 shutdown, 1013 slow reader). */
    data class Closed(val code: Int, val reason: String) : StreamSignal

    /** Upgrade refused ([httpStatus] set) or the connection failed. */
    data class Failed(val httpStatus: Int?, val message: String) : StreamSignal
}

object CloseCodes {
    const val NORMAL = 1000
    const val GOING_AWAY = 1001
    const val TRY_AGAIN_LATER = 1013
    const val TOKEN_REVOKED = 4401

    /** Client-side: drop the stream to start over with a full resync. */
    const val CLIENT_RESYNC = 4000
}

/**
 * One `/events` connection as a cold [Flow]. Collecting opens the socket;
 * cancelling the collector closes it. The flow completes after Closed/Failed.
 */
fun OkHttpClient.eventStream(request: Request): Flow<StreamSignal> = callbackFlow {
    val socket = newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            trySendBlocking(StreamSignal.Opened)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val json = parseObject(text)
            trySendBlocking(if (json == null) StreamSignal.Malformed else StreamSignal.Frame(json))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(CloseCodes.NORMAL, null)
            trySendBlocking(StreamSignal.Closed(code, reason))
            channel.close()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            trySendBlocking(StreamSignal.Closed(code, reason))
            channel.close()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val status = response?.code
            response?.close()
            trySendBlocking(StreamSignal.Failed(status, t.message ?: t.javaClass.simpleName))
            channel.close()
        }
    })
    awaitClose { socket.close(CloseCodes.NORMAL, null) }
}
