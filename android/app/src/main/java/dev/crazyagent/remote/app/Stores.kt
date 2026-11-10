package dev.crazyagent.remote.app

import dev.crazyagent.remote.data.ServerConfig

/**
 * A prompt whose delivery has not been confirmed. Persisted (encrypted) so a
 * process death between "sent" and "accepted" is surfaced, never resent blindly.
 * Image bytes are not persisted; only their count.
 */
data class StoredPending(
    val clientMessageId: String,
    val text: String,
    val imageCount: Int,
    val instanceId: String?,
    val planMode: Boolean = false,
    val steer: Boolean = false,
) {
    override fun toString(): String = "StoredPending($clientMessageId, ${text.length} chars, $imageCount images, $instanceId)"
}

interface PairingStore {
    suspend fun load(): ServerConfig?
    suspend fun save(config: ServerConfig)
    suspend fun clear()
}

interface PendingStore {
    suspend fun load(): StoredPending?
    suspend fun save(pending: StoredPending)
    suspend fun clear()
}

/** In-memory stores for tests and previews. */
class MemoryPendingStore(var value: StoredPending? = null) : PendingStore {
    override suspend fun load() = value
    override suspend fun save(pending: StoredPending) { value = pending }
    override suspend fun clear() { value = null }
}
