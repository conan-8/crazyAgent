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
        assertEquals(PushMessage.Type.CONFIRM, PushMessage.parse(good + ("type" to "confirm"))!!.type)
        // M5: the watch type is additive; an old APK drops it, this one accepts it.
        assertEquals(PushMessage.Type.WATCH, PushMessage.parse(good + ("type" to "watch"))!!.type)
        // V7: the test type is additive the same way.
        assertEquals(PushMessage.Type.TEST, PushMessage.parse(good + ("type" to "test"))!!.type)
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
        val confirm = PushMessage.parse(good + ("type" to "confirm"))!!
        val error = PushMessage.parse(good + ("type" to "error"))!!
        val watch = PushMessage.parse(good + ("type" to "watch"))!!
        val test = PushMessage.parse(good + ("type" to "test"))!!
        assertEquals("crazyAgent needs you", help.title)
        assertEquals("crazyAgent finished", done.title)
        assertEquals("crazyAgent needs your approval", confirm.title)
        // Q10: a malformed-reply turn ends as chat.error and pushes the error type.
        assertEquals("crazyAgent stopped on an error", error.title)
        assertEquals("Open to see what went wrong.", error.text)
        // M5: generic watch wording only — the reason is fetched after the tap.
        assertEquals("crazyAgent may be stuck", watch.title)
        assertEquals("Open to see what it is doing.", watch.text)
        // V7: the test notification says only that push reaches this phone.
        assertEquals("crazyAgent test notification", test.title)
        assertEquals("Push notifications reach this phone.", test.text)
        // A later push for the same turn replaces the earlier notification.
        assertEquals(help.notificationId, done.notificationId)
        assertEquals(help.notificationId, confirm.notificationId)
        assertEquals(help.notificationId, error.notificationId)
        assertEquals(help.notificationId, watch.notificationId)
        assertEquals(help.notificationId, test.notificationId)
        for (message in listOf(help, done, confirm, error, watch, test)) {
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
