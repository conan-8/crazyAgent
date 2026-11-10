package dev.crazyagent.remote.notifications

/**
 * The metadata a push may carry (`docs/REMOTE-ACCESS.md` §4.9). It never holds
 * chat text, a help reason, or a credential; everything shown after a tap is
 * fetched over the authenticated remote API.
 */
data class PushMessage(val type: Type, val turnId: String, val instanceId: String, val sequence: Long) {
    enum class Type(val wire: String) { HELP("help"), DONE("done"), ERROR("error") }

    companion object {
        private val ID = Regex("^[A-Za-z0-9_.:-]{1,128}$")
        private val KEYS = setOf("type", "turnId", "instanceId", "sequence")

        /**
         * Accept only the exact shape the companion sends. Anything else,
         * including extra keys, is dropped: a notification must not be built
         * from data this app does not understand.
         */
        fun parse(data: Map<String, String?>): PushMessage? {
            if (data.keys != KEYS) return null
            val type = Type.entries.firstOrNull { it.wire == data["type"] } ?: return null
            val turnId = data["turnId"]?.takeIf { ID.matches(it) } ?: return null
            val instanceId = data["instanceId"]?.takeIf { ID.matches(it) } ?: return null
            val sequence = data["sequence"]?.takeIf { it.length <= 18 }?.toLongOrNull()?.takeIf { it >= 0 } ?: return null
            return PushMessage(type, turnId, instanceId, sequence)
        }
    }

    fun toMap(): Map<String, String> = mapOf("type" to type.wire, "turnId" to turnId, "instanceId" to instanceId, "sequence" to sequence.toString())

    /** Generic wording only: the notification shade is not a place for chat content. */
    val title: String
        get() = when (type) {
            Type.HELP -> "crazyAgent needs you"
            Type.DONE -> "crazyAgent finished"
            Type.ERROR -> "crazyAgent stopped on an error"
        }

    val text: String
        get() = when (type) {
            Type.HELP -> "Open to see what is blocking it and reply."
            Type.DONE -> "Open to read the result."
            Type.ERROR -> "Open to see what went wrong."
        }

    /** One notification per turn: a later push for the same turn replaces it. */
    val notificationId: Int get() = turnId.hashCode()
}

/** What the app knows about push on this phone and for this pairing. */
data class PushState(val status: Status = Status.OFF_IN_APP, val detail: String? = null) {
    enum class Status {
        /** This build has no Firebase configuration. */
        OFF_IN_APP,

        /** Android will not show notifications until the user allows them. */
        NEEDS_PERMISSION,
        REGISTERING,
        REGISTERED,

        /** The computer has no FCM key, so it cannot send anything. */
        OFF_ON_COMPUTER,
        FAILED,
    }

    val label: String
        get() = when (status) {
            Status.OFF_IN_APP -> "Not set up in this app build"
            Status.NEEDS_PERMISSION -> "Blocked in Android settings"
            Status.REGISTERING -> "Registering…"
            Status.REGISTERED -> "On"
            Status.OFF_ON_COMPUTER -> "Not set up on the computer"
            Status.FAILED -> "Could not register"
        }
}
