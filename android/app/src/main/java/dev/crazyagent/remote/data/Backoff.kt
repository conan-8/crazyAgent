package dev.crazyagent.remote.data

import kotlin.math.min

/** Bounded exponential reconnect delay with "equal jitter". */
object Backoff {
    const val BASE_MS = 500L
    const val MAX_MS = 30_000L

    /**
     * @param attempt 0 for the first retry after a failure.
     * @param random a value in [0, 1).
     */
    fun delayMs(attempt: Int, random: Double): Long {
        val shift = attempt.coerceIn(0, 16)
        val ceiling = min(MAX_MS, BASE_MS shl shift)
        val half = ceiling / 2
        return half + (half * random.coerceIn(0.0, 1.0)).toLong()
    }
}
