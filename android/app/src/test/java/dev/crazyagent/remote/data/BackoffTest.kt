package dev.crazyagent.remote.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffTest {
    @Test fun growsExponentiallyWithinJitterBounds() {
        assertEquals(250, Backoff.delayMs(0, 0.0))
        assertEquals(500, Backoff.delayMs(0, 1.0))
        assertEquals(1_000, Backoff.delayMs(2, 0.0))
        for (attempt in 0..40) {
            for (r in listOf(0.0, 0.3, 0.999)) {
                val d = Backoff.delayMs(attempt, r)
                assertTrue("attempt $attempt", d in 250..Backoff.MAX_MS)
            }
        }
    }

    @Test fun capsAtTheMaximum() {
        assertEquals(Backoff.MAX_MS / 2, Backoff.delayMs(30, 0.0))
        assertEquals(Backoff.MAX_MS, Backoff.delayMs(30, 1.0))
        assertEquals(Backoff.MAX_MS, Backoff.delayMs(-1 + 100, 1.0))
    }
}
