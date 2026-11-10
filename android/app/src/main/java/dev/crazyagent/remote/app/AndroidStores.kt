package dev.crazyagent.remote.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.crazyagent.remote.data.ServerConfig
import dev.crazyagent.remote.data.ServerInput
import dev.crazyagent.remote.data.ServerInputResult
import dev.crazyagent.remote.data.bool
import dev.crazyagent.remote.data.int
import dev.crazyagent.remote.data.parseObject
import dev.crazyagent.remote.data.string
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

val Context.remoteDataStore: DataStore<Preferences> by preferencesDataStore(name = "remote")

/**
 * AES-GCM with a non-exportable Android Keystore key. Used for the remote
 * token and any pending prompt text; neither is stored in plain text.
 */
class KeystoreCipher(private val alias: String = "crazyagent-remote-v1") {
    fun encrypt(plain: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain)
        return Base64.getEncoder().encodeToString(sealed)
    }

    /** @return null if the data or key is unusable (for example after a key reset). */
    fun decrypt(encoded: String): ByteArray? = try {
        val sealed = Base64.getDecoder().decode(encoded)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    } catch (_: Exception) {
        null
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

private val SERVER_URL = stringPreferencesKey("server_url")
private val TOKEN = stringPreferencesKey("token_enc")
private val PENDING = stringPreferencesKey("pending_enc")

class DataStorePairingStore(
    private val store: DataStore<Preferences>,
    private val cipher: KeystoreCipher,
    private val allowLoopbackCleartext: Boolean,
) : PairingStore {
    override suspend fun load(): ServerConfig? {
        val prefs = store.data.first()
        val url = prefs[SERVER_URL] ?: return null
        val token = prefs[TOKEN]?.let(cipher::decrypt)?.toString(Charsets.UTF_8) ?: return null
        return (ServerInput.validate(url, token, allowLoopbackCleartext) as? ServerInputResult.Valid)?.config
    }

    suspend fun lastUrl(): String? = store.data.first()[SERVER_URL]

    override suspend fun save(config: ServerConfig) {
        val sealed = cipher.encrypt(config.token.toByteArray(Charsets.UTF_8))
        store.edit {
            it[SERVER_URL] = config.baseUrl.toString()
            it[TOKEN] = sealed
        }
    }

    /** Forget the token; keep the address so re-pairing only needs a new token. */
    override suspend fun clear() {
        store.edit {
            it.remove(TOKEN)
            it.remove(PENDING)
        }
    }
}

class DataStorePendingStore(
    private val store: DataStore<Preferences>,
    private val cipher: KeystoreCipher,
) : PendingStore {
    override suspend fun load(): StoredPending? {
        val sealed = store.data.first()[PENDING] ?: return null
        val json = cipher.decrypt(sealed)?.toString(Charsets.UTF_8)?.let(::parseObject) ?: return null
        return StoredPending(
            clientMessageId = json.string("id") ?: return null,
            text = json.string("text").orEmpty(),
            imageCount = json.int("imageCount") ?: 0,
            instanceId = json.string("instanceId"),
            planMode = json.bool("planMode") == true,
            steer = json.bool("steer") == true,
        )
    }

    override suspend fun save(pending: StoredPending) {
        val json = JsonObject(mapOf(
            "id" to JsonPrimitive(pending.clientMessageId),
            "text" to JsonPrimitive(pending.text),
            "imageCount" to JsonPrimitive(pending.imageCount),
            "instanceId" to (pending.instanceId?.let(::JsonPrimitive) ?: JsonNull),
            "planMode" to JsonPrimitive(pending.planMode),
            "steer" to JsonPrimitive(pending.steer),
        ))
        val sealed = cipher.encrypt(json.toString().toByteArray(Charsets.UTF_8))
        store.edit { it[PENDING] = sealed }
    }

    override suspend fun clear() {
        store.edit { it.remove(PENDING) }
    }
}
