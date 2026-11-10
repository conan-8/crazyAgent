package dev.crazyagent.remote

import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.crazyagent.remote.app.MainViewModel
import dev.crazyagent.remote.app.RemoteController
import dev.crazyagent.remote.app.Screen
import dev.crazyagent.remote.ui.ChatActions
import dev.crazyagent.remote.ui.ChatScreen
import dev.crazyagent.remote.ui.PairingScreen
import dev.crazyagent.remote.ui.RemoteTheme
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    // Delivered on the main thread (see onStart). Touching the lazy `viewModel` from
    // ConnectivityThread used to race the main thread and create a second MainViewModel,
    // which left the run loop watching a cleared instance stuck on Loading.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            (viewModel.screen.value as? Screen.Chat)?.controller?.nudge()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Create the ViewModel on the main thread before anything else can reach it.
        val viewModel = viewModel
        // Keep the remote token (and chat text) out of autofill/password managers such as
        // Samsung Pass. Compose marks its own view important, so exclude from the window root.
        window.decorView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS

        if (savedInstanceState == null) handleNotificationIntent(intent)

        // Stream events only while the app is visible; reopening replays or resyncs.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.screen.collectLatest { screen ->
                    if (screen is Screen.Chat) screen.controller.run()
                }
            }
        }

        setContent {
            RemoteTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val screen by viewModel.screen.collectAsStateWithLifecycle()
                    when (val current = screen) {
                        Screen.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                        is Screen.Pairing -> PairingScreen(current, onPair = viewModel::pair, onCancel = viewModel::cancelPairing)
                        is Screen.Chat -> Chat(current.controller)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNotificationIntent(intent)
    }

    private fun handleNotificationIntent(intent: android.content.Intent?) {
        val message = dev.crazyagent.remote.notifications.Notifier.fromIntent(intent) ?: return
        dev.crazyagent.remote.notifications.Notifier.consume(intent)
        viewModel.openedFromNotification(message)
    }

    override fun onStart() {
        super.onStart()
        dev.crazyagent.remote.notifications.Notifier.appVisible = true
        // Permission or the token may have changed while the app was away.
        viewModel.syncPush()
        getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(networkCallback, Handler(Looper.getMainLooper()))
    }

    override fun onStop() {
        dev.crazyagent.remote.notifications.Notifier.appVisible = false
        runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(networkCallback) }
        super.onStop()
    }

    /**
     * Ask once with the system prompt; after that (or on Android 12 and
     * older) only the system settings can change it.
     */
    private fun canAskForNotifications(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 33 || askedForNotifications) return false
        return checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    private var askedForNotifications = false

    @Composable
    private fun Chat(controller: RemoteController) {
        val state by controller.state.collectAsStateWithLifecycle()
        val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { viewModel.syncPush() }
        val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(RemoteController.MAX_IMAGES)) { uris ->
            if (uris.isNotEmpty()) viewModel.addImages(uris)
        }
        ChatScreen(
            state,
            ChatActions(
                onComposer = controller::updateComposer,
                onSend = controller::send,
                onStop = controller::stop,
                onNewChat = controller::newChat,
                onPickImages = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                onRemoveImage = controller::removeImage,
                onRetryPending = controller::retryPending,
                onResendPending = controller::resendPendingAsNew,
                onEditPending = controller::editPending,
                onDiscardPending = controller::discardPending,
                onDismissNotice = controller::dismissNotice,
                onReconnect = controller::nudge,
                onEditPairing = viewModel::editPairing,
                onForget = viewModel::unpair,
                onRefreshSessions = controller::refreshSessions,
                onOpenHistory = controller::openHistory,
                onCloseHistory = controller::closeHistory,
                onResumeChat = controller::resumeChat,
                onTogglePlanMode = controller::togglePlanMode,
                onCaptureScreen = controller::captureScreen,
                onEnableNotifications = {
                    if (android.os.Build.VERSION.SDK_INT >= 33 && canAskForNotifications()) {
                        askedForNotifications = true
                        notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        startActivity(
                            android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName),
                        )
                    }
                },
            ),
        )
    }
}
