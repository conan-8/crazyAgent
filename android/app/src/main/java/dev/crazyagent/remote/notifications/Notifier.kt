package dev.crazyagent.remote.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.crazyagent.remote.MainActivity
import dev.crazyagent.remote.R

/** Builds the local notification for a validated push. */
object Notifier {
    private const val CHANNEL_HELP = "agent_help"
    private const val CHANNEL_TURNS = "agent_turns"
    private const val EXTRA_PREFIX = "crazyagent.push."

    /** True while the chat is on screen; the live stream already shows the event. */
    @Volatile var appVisible: Boolean = false

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_HELP, "Agent needs you", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "The agent is blocked and waiting for you."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_TURNS, "Finished turns", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A turn finished or failed."
            },
        )
    }

    /** Whether Android will currently show this app's notifications at all. */
    fun allowed(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** @return true when a notification was posted. The user's channel settings still apply. */
    fun show(context: Context, message: PushMessage): Boolean {
        if (appVisible || !allowed(context)) return false
        ensureChannels(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            for ((key, value) in message.toMap()) putExtra(EXTRA_PREFIX + key, value)
        }
        val pending = PendingIntent.getActivity(context, message.notificationId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val help = message.type == PushMessage.Type.HELP
        val notification = NotificationCompat.Builder(context, if (help) CHANNEL_HELP else CHANNEL_TURNS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(message.title)
            .setContentText(message.text)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(if (help) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (help) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        return try {
            NotificationManagerCompat.from(context).notify(message.notificationId, notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    /** The push a tapped notification carried, revalidated; null for an ordinary launch. */
    fun fromIntent(intent: Intent?): PushMessage? {
        val extras = intent?.extras ?: return null
        val data = extras.keySet().filter { it.startsWith(EXTRA_PREFIX) }.associate { it.removePrefix(EXTRA_PREFIX) to extras.getString(it) }
        return if (data.isEmpty()) null else PushMessage.parse(data)
    }

    /** Remove the extras so a recreated activity does not handle the same tap twice. */
    fun consume(intent: Intent?) {
        val extras = intent?.extras ?: return
        for (key in extras.keySet().filter { it.startsWith(EXTRA_PREFIX) }) intent.removeExtra(key)
    }
}
