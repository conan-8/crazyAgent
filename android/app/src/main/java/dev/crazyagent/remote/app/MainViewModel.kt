package dev.crazyagent.remote.app

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.crazyagent.remote.BuildConfig
import dev.crazyagent.remote.data.ApiResult
import dev.crazyagent.remote.data.RemoteApi
import dev.crazyagent.remote.data.ServerConfig
import dev.crazyagent.remote.data.ServerInput
import dev.crazyagent.remote.data.ServerInputResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import dev.crazyagent.remote.notifications.Notifier
import dev.crazyagent.remote.notifications.PushMessage
import dev.crazyagent.remote.notifications.PushSetup
import dev.crazyagent.remote.notifications.PushState
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

sealed interface Screen {
    data object Loading : Screen
    data class Pairing(
        val url: String,
        val urlError: String? = null,
        val tokenError: String? = null,
        val error: String? = null,
        val busy: Boolean = false,
        val canCancel: Boolean = false,
    ) : Screen
    data class Chat(val controller: RemoteController) : Screen
}

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val allowLoopbackCleartext = BuildConfig.DEBUG
    private val cipher = KeystoreCipher()
    private val pairingStore = DataStorePairingStore(application.remoteDataStore, cipher, allowLoopbackCleartext)
    private val pendingStore = DataStorePendingStore(application.remoteDataStore, cipher)
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val _screen = MutableStateFlow<Screen>(Screen.Loading)
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    init {
        viewModelScope.launch {
            val config = pairingStore.load()
            if (config == null) {
                _screen.value = Screen.Pairing(url = pairingStore.lastUrl().orEmpty().trimEnd('/'))
            } else {
                open(config)
            }
        }
    }

    /** Validate input, prove it against `/state`, then store it encrypted. */
    fun pair(url: String, token: String) {
        val current = _screen.value as? Screen.Pairing ?: return
        when (val input = ServerInput.validate(url, token, allowLoopbackCleartext)) {
            is ServerInputResult.Invalid -> _screen.value = current.copy(url = url, urlError = input.urlError, tokenError = input.tokenError, error = null)
            is ServerInputResult.Valid -> {
                _screen.value = current.copy(url = url, urlError = null, tokenError = null, error = null, busy = true)
                viewModelScope.launch {
                    val error = when (val result = RemoteApi(client, input.config).state()) {
                        is ApiResult.Ok -> null
                        is ApiResult.Rejected -> if (result.status == 401) "The companion rejected this token." else result.message
                        is ApiResult.Unreachable -> result.reason
                    }
                    if (error != null) {
                        _screen.update { (it as? Screen.Pairing)?.copy(busy = false, error = error) ?: it }
                        return@launch
                    }
                    pairingStore.save(input.config)
                    open(input.config)
                }
            }
        }
    }

    /** Show pairing again to replace the token (the old pairing stays until a new one succeeds). */
    fun editPairing() {
        val chat = _screen.value as? Screen.Chat ?: return
        previous = chat
        _screen.value = Screen.Pairing(url = pairingUrl.orEmpty(), canCancel = true)
    }

    fun cancelPairing() {
        val back = previous ?: return
        previous = null
        _screen.value = back
    }

    /** Forget the token and any pending prompt on this phone. */
    fun unpair() {
        viewModelScope.launch {
            // Stop notifications for this pairing while the token still works (bounded, best effort).
            val leaving = (_screen.value as? Screen.Chat)?.controller ?: previous?.controller
            if (leaving != null && PushSetup.configuredInApp) {
                withTimeoutOrNull(4_000) { leaving.unregisterPush(PushSetup.deviceId(getApplication())) }
            }
            pairingStore.clear()
            (_screen.value as? Screen.Chat)?.controller?.close()
            previous?.controller?.close()
            previous = null
            _screen.value = Screen.Pairing(url = pairingStore.lastUrl().orEmpty().trimEnd('/'))
        }
    }

    fun addImages(uris: List<Uri>) {
        val controller = (_screen.value as? Screen.Chat)?.controller ?: return
        viewModelScope.launch {
            val prepared = ImagePreparer.prepare(getApplication<Application>().contentResolver, uris, controller.state.value.attachments)
            controller.addImages(prepared.images)
            prepared.problem?.let { problem -> controller.noticeFromUi(problem) }
        }
    }

    private var previous: Screen.Chat? = null
    private var pairingUrl: String? = null

    /**
     * Bring this phone's push registration up to date for the current pairing.
     * Safe to call often: the companion replaces the same device's token.
     */
    fun syncPush() {
        val controller = (_screen.value as? Screen.Chat)?.controller ?: return
        val app = getApplication<Application>()
        viewModelScope.launch {
            if (!PushSetup.configuredInApp) return@launch controller.setPushState(PushState(PushState.Status.OFF_IN_APP))
            if (!Notifier.allowed(app)) return@launch controller.setPushState(PushState(PushState.Status.NEEDS_PERMISSION))
            val token = PushSetup.currentToken()
                ?: return@launch controller.setPushState(PushState(PushState.Status.FAILED, "Google Play services gave no push token."))
            controller.registerPush(PushSetup.deviceId(app), token, BuildConfig.VERSION_NAME)
        }
    }

    /** A notification was tapped: show the companion's current state for it. */
    fun openedFromNotification(message: PushMessage) {
        pendingOpen = message
        deliverPendingOpen()
    }

    private var pendingOpen: PushMessage? = null

    private fun deliverPendingOpen() {
        val message = pendingOpen ?: return
        val controller = (_screen.value as? Screen.Chat)?.controller ?: return
        pendingOpen = null
        controller.openedFromNotification(message)
    }

    private suspend fun open(config: ServerConfig) {
        pairingUrl = config.baseUrl.toString().trimEnd('/')
        previous?.controller?.close()
        (_screen.value as? Screen.Chat)?.controller?.close()
        val controller = RemoteController(config, client, pendingStore, viewModelScope)
        controller.restore()
        previous = null
        _screen.value = Screen.Chat(controller)
        deliverPendingOpen()
        syncPush()
    }
}
