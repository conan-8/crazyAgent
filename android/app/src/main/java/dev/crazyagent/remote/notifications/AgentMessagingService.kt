package dev.crazyagent.remote.notifications

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.crazyagent.remote.BuildConfig
import dev.crazyagent.remote.app.DataStorePairingStore
import dev.crazyagent.remote.app.KeystoreCipher
import dev.crazyagent.remote.app.remoteDataStore
import dev.crazyagent.remote.data.RemoteApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Receives FCM data messages. A message is shown only if it has exactly the
 * expected metadata shape; nothing from it is displayed verbatim.
 */
class AgentMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(message: RemoteMessage) {
        val push = PushMessage.parse(message.data) ?: return
        Notifier.show(applicationContext, push)
    }

    /**
     * FCM rotated this phone's token. Re-register right away when the pairing
     * is reachable; otherwise the next app start does it.
     */
    override fun onNewToken(token: String) {
        scope.launch {
            val pairing = DataStorePairingStore(applicationContext.remoteDataStore, KeystoreCipher(), BuildConfig.DEBUG).load() ?: return@launch
            val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
            RemoteApi(client, pairing).registerPush(PushSetup.deviceId(applicationContext), token, BuildConfig.VERSION_NAME)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
