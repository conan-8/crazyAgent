package dev.crazyagent.remote.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveViewMathTest {
    @Test fun aDesktopViewportGetsItsExactFullWidthHeight() {
        // 1280x800 on a 412x890 dp phone: 412 / 1.6 = 257.5 dp, under the cap.
        assertEquals(257.5f, LiveViewMath.paneHeightDp(412f, 890f, 1280f / 800f)!!, 0.01f)
    }

    @Test fun tallAndSquareCapturesAreCappedSoTheChatKeepsRoom() {
        assertEquals(445f, LiveViewMath.paneHeightDp(412f, 890f, 720f / 2400f)!!, 0.01f)
        assertEquals(412f, LiveViewMath.paneHeightDp(412f, 890f, 1f)!!, 0.01f)
        // Shorter window: the reserve for header, chat, and composer wins over half the height.
        assertEquals(260f, LiveViewMath.paneHeightDp(412f, 560f, 1f)!!, 0.01f)
    }

    @Test fun aVeryWideCaptureStillGetsATappableStrip() {
        assertEquals(LiveViewMath.MIN_PANE_DP, LiveViewMath.paneHeightDp(412f, 890f, 10f)!!, 0.01f)
    }

    @Test fun thePaneHidesWhenThereIsNoRoomOrNoUsableShape() {
        assertNull(LiveViewMath.paneHeightDp(412f, 380f, 1.6f))
        assertNull(LiveViewMath.paneHeightDp(412f, 890f, 0f))
        assertNull(LiveViewMath.paneHeightDp(412f, 890f, Float.NaN))
        assertNull(LiveViewMath.paneHeightDp(0f, 890f, 1.6f))
    }

    @Test fun sideBySideOnlyInAClearlyWideWindow() {
        assertTrue(LiveViewMath.sideBySide(890f, 412f))
        assertTrue(LiveViewMath.sideBySide(1280f, 800f))
        assertFalse(LiveViewMath.sideBySide(412f, 890f))
        assertFalse(LiveViewMath.sideBySide(800f, 760f))
        assertFalse(LiveViewMath.sideBySide(500f, 300f))
    }

    @Test fun panIsLimitedToTheZoomedImageEdges() {
        assertEquals(0f, LiveViewMath.maxPan(1000f, 1000f, 1f), 0f)
        assertEquals(500f, LiveViewMath.maxPan(1000f, 1000f, 2f), 0f)
        // Letterboxed axis: no pan until the zoomed image is larger than the viewport.
        assertEquals(0f, LiveViewMath.maxPan(2000f, 600f, 3f), 0f)
        assertEquals(200f, LiveViewMath.maxPan(2000f, 600f, 4f), 0f)
    }

    @Test fun hugeCapturesAreDownsampled() {
        assertEquals(1, LiveViewMath.sampleSize(2560, 1600))
        assertEquals(4, LiveViewMath.sampleSize(1280, 30_000))
        assertEquals(2, LiveViewMath.sampleSize(4000, 4000))
    }

    @Test fun captureAgeAndSourceAreSpelledOut() {
        val at = "2026-11-09T12:00:00.000Z"
        val base = java.time.Instant.parse(at).toEpochMilli()
        assertEquals("just now", LiveViewMath.ageLabel(at, base + 4_000))
        // A phone clock slightly behind the computer must not read as the future.
        assertEquals("just now", LiveViewMath.ageLabel(at, base - 30_000))
        assertEquals("45s ago", LiveViewMath.ageLabel(at, base + 45_000))
        assertEquals("12m ago", LiveViewMath.ageLabel(at, base + 12 * 60_000 + 5_000))
        assertEquals("3h ago", LiveViewMath.ageLabel(at, base + 3 * 3_600_000L))
        assertEquals("2d ago", LiveViewMath.ageLabel(at, base + 2 * 86_400_000L))
        assertNull(LiveViewMath.ageLabel(null, base))
        assertNull(LiveViewMath.ageLabel("yesterday", base))
        assertEquals("Agent view · 45s ago", LiveViewMath.caption("tool", at, base + 45_000))
        assertEquals("Agent view · just now", LiveViewMath.caption("auto", at, base))
        assertEquals("Your capture · just now", LiveViewMath.caption("manual", at, base))
        assertEquals("Where the agent is stuck", LiveViewMath.caption("help", null, base))
    }
}
