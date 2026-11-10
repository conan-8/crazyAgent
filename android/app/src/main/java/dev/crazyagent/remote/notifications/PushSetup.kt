package dev.crazyagent.remote.notifications

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import dev.crazyagent.remote.BuildConfig
import dev.crazyagent.remote.app.remoteDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.UUID
import kotlin.coroutines.resume

/**
 * Firebase is initialized by hand from `firebase.properties` (build-time,
 * local, never committed) instead of a `google-services.json` plugin step, so
 * the app still builds and runs, with push off, when no Firebase app exists.
 */
object PushSetup {
    private val DEVICE_ID = stringPreferencesKey("push_device_id")

    val configuredInApp: Boolean
        get() = BuildConfig.FIREBASE_PROJECT_ID.isNotEmpty() && BuildConfig.FIREBASE_APPLICATION_ID.isNotEmpty() &&
            BuildConfig.FIREBASE_API_KEY.isNotEmpty() && BuildConfig.FIREBASE_SENDER_ID.isNotEmpty()

    /** Idempotent; call from Application.onCreate so a push can wake a dead process. */
    fun initialize(context: Context): Boolean {
        if (!configuredInApp) return false
        return try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                        .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                        .setApiKey(BuildConfig.FIREBASE_API_KEY)
                        .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                        .build(),
                )
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    /** A random per-install ID for this phone's registration; not derived from hardware. */
    suspend fun deviceId(context: Context): String {
        val store = context.remoteDataStore
        store.data.first()[DEVICE_ID]?.let { return it }
        val created = "android-${UUID.randomUUID()}"
        store.edit { if (it[DEVICE_ID] == null) it[DEVICE_ID] = created }
        return store.data.first()[DEVICE_ID] ?: created
    }

    /** The current FCM registration token, or null when Firebase/Play services cannot give one. */
    suspend fun currentToken(): String? = suspendCancellableCoroutine { continuation ->
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (continuation.isActive) continuation.resume(if (task.isSuccessful) task.result else null)
            }
        } catch (_: Exception) {
            if (continuation.isActive) continuation.resume(null)
        }
    }
}
