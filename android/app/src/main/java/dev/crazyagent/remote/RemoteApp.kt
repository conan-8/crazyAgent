package dev.crazyagent.remote

import android.app.Application
import dev.crazyagent.remote.notifications.Notifier
import dev.crazyagent.remote.notifications.PushSetup

class RemoteApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Before any component: a push can start this process with no activity.
        if (PushSetup.initialize(this)) Notifier.ensureChannels(this)
    }
}
