package dev.crazyagent.remote.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** A validated pairing: the companion's remote base URL and its bearer token. */
data class ServerConfig(val baseUrl: HttpUrl, val token: String) {
    /** Host shown in the UI; never includes the token. */
    val displayHost: String get() = if (baseUrl.port == HttpUrl.defaultPort(baseUrl.scheme)) baseUrl.host else "${baseUrl.host}:${baseUrl.port}"

    override fun toString(): String = "ServerConfig(baseUrl=$baseUrl, token=<redacted>)"
}

sealed interface ServerInputResult {
    data class Valid(val config: ServerConfig) : ServerInputResult
    data class Invalid(val urlError: String?, val tokenError: String?) : ServerInputResult
}

object ServerInput {
    private val TOKEN = Regex("^[0-9a-f]{64}$")
    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost")

    /**
     * Validate what the user typed or pasted.
     *
     * The address must be the HTTPS Tailscale Serve URL. A pasted `/remote/v1`
     * suffix or trailing slash is accepted and normalized away. Plain HTTP is
     * allowed only to the phone's own loopback in debug builds, for a fake
     * companion reached through `adb reverse`.
     */
    fun validate(url: String, token: String, allowLoopbackCleartext: Boolean): ServerInputResult {
        val urlResult = normalizeUrl(url.trim(), allowLoopbackCleartext)
        val cleanToken = token.trim()
        val tokenError = when {
            cleanToken.isEmpty() -> "Paste the token printed by --pair-remote."
            !TOKEN.matches(cleanToken) -> "The token is 64 lowercase hex characters."
            else -> null
        }
        val baseUrl = urlResult.getOrNull()
        return if (baseUrl != null && tokenError == null) {
            ServerInputResult.Valid(ServerConfig(baseUrl, cleanToken))
        } else {
            ServerInputResult.Invalid(urlResult.exceptionOrNull()?.message, tokenError)
        }
    }

    private fun normalizeUrl(raw: String, allowLoopbackCleartext: Boolean): Result<HttpUrl> {
        if (raw.isEmpty()) return Result.failure(IllegalArgumentException("Enter the https:// address from Tailscale Serve."))
        val withScheme = if (raw.contains("://")) raw else "https://$raw"
        val parsed = withScheme.toHttpUrlOrNull()
            ?: return Result.failure(IllegalArgumentException("That is not a valid address."))
        if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) {
            return Result.failure(IllegalArgumentException("Do not put credentials in the address."))
        }
        if (parsed.query != null || parsed.fragment != null) {
            return Result.failure(IllegalArgumentException("Remove the ?query or #fragment from the address."))
        }
        val segments = parsed.pathSegments.filter { it.isNotEmpty() }
        val prefix = if (segments.takeLast(2) == listOf("remote", "v1")) segments.dropLast(2) else segments
        if (prefix.isNotEmpty()) {
            return Result.failure(IllegalArgumentException("Use the server address only, without a path."))
        }
        if (parsed.scheme == "http") {
            if (!(allowLoopbackCleartext && parsed.host in LOOPBACK_HOSTS)) {
                return Result.failure(IllegalArgumentException("Use https://. Plain http is only allowed to this phone's loopback in debug builds."))
            }
        }
        val base = parsed.newBuilder().encodedPath("/").build()
        return Result.success(base)
    }
}
