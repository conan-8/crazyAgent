package dev.crazyagent.remote.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class PushMessageTest {
    private val good = mapOf("type" to "help", "turnId" to "turn-mabc12-4f0e", "instanceId" to "companion-mabc-0011aabbccdd", "sequence" to "123")

    @Test fun theExactMetadataShapeIsAccepted() {
        val message = PushMessage.parse(good)!!
        assertEquals(PushMessage(PushMessage.Type.HELP, "turn-mabc12-4f0e", "companion-mabc-0011aabbccdd", 123), message)
        assertEquals(good, message.toMap())
        assertEquals(PushMessage.Type.DONE, PushMessage.parse(good + ("type" to "done"))!!.type)
        assertEquals(PushMessage.Type.ERROR, PushMessage.parse(good + ("type" to "error"))!!.type)
    }

    @Test fun anythingElseIsDropped() {
        val bad = listOf(
            emptyMap(),
            good - "sequence",
            good + ("text" to "Your code is 123456"),
            good + ("type" to "tool_call"),
            good + ("type" to "HELP"),
            good + ("turnId" to ""),
            good + ("turnId" to "turn/../../etc"),
            good + ("turnId" to "t".repeat(129)),
            good + ("instanceId" to "has space"),
            good + ("instanceId" to null),
            good + ("sequence" to "-1"),
            good + ("sequence" to "12.5"),
            good + ("sequence" to "9".repeat(19)),
            good + ("sequence" to "abc"),
        )
        for (data in bad) assertNull(data.toString(), PushMessage.parse(data))
    }

    @Test fun notificationTextIsGenericAndOneNotificationPerTurn() {
        val help = PushMessage.parse(good)!!
        val done = PushMessage.parse(good + ("type" to "done"))!!
        assertEquals("crazyAgent needs you", help.title)
        assertEquals("crazyAgent finished", done.title)
        // A later push for the same turn replaces the earlier notification.
        assertEquals(help.notificationId, done.notificationId)
        for (message in listOf(help, done, PushMessage.parse(good + ("type" to "error"))!!)) {
            for (text in listOf(message.title, message.text)) {
                assertFalse(text.contains(message.turnId))
                assertFalse(text.contains(message.instanceId))
            }
        }
    }

    @Test fun everyStatusHasAPlainLabel() {
        for (status in PushState.Status.entries) assertFalse(PushState(status).label.isBlank())
        assertEquals("On", PushState(PushState.Status.REGISTERED).label)
    }
}
