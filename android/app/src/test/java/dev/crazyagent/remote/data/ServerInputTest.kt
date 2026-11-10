package dev.crazyagent.remote.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerInputTest {
    private val token = "a".repeat(64)

    private fun valid(url: String, cleartext: Boolean = false) =
        (ServerInput.validate(url, token, cleartext) as ServerInputResult.Valid).config

    private fun urlError(url: String, cleartext: Boolean = false) =
        (ServerInput.validate(url, token, cleartext) as ServerInputResult.Invalid).urlError

    @Test fun normalizesTailscaleAddresses() {
        assertEquals("https://host.tail11f47e.ts.net/", valid("host.tail11f47e.ts.net").baseUrl.toString())
        assertEquals("https://host.tail11f47e.ts.net/", valid(" https://host.tail11f47e.ts.net/ ").baseUrl.toString())
        assertEquals("https://host.tail11f47e.ts.net/", valid("https://host.tail11f47e.ts.net/remote/v1").baseUrl.toString())
        assertEquals("https://host.tail11f47e.ts.net:8443/", valid("https://host.tail11f47e.ts.net:8443/remote/v1/").baseUrl.toString())
        assertEquals("host.tail11f47e.ts.net:8443", valid("https://host.tail11f47e.ts.net:8443").displayHost)
    }

    @Test fun refusesCleartextExceptDebugLoopback() {
        assertNotNull(urlError("http://host.tail11f47e.ts.net"))
        assertNotNull(urlError("http://127.0.0.1:17883"))
        assertEquals("http://127.0.0.1:17883/", valid("http://127.0.0.1:17883", cleartext = true).baseUrl.toString())
        assertNotNull(urlError("http://192.168.1.5:17873", cleartext = true))
    }

    @Test fun refusesPathsQueriesAndCredentials() {
        assertNotNull(urlError("https://host/bridge"))
        assertNotNull(urlError("https://host/?token=x"))
        assertNotNull(urlError("https://user:pw@host"))
        assertNotNull(urlError(""))
        assertNotNull(urlError("ht!tp://"))
    }

    @Test fun tokenMustBe64LowercaseHex() {
        val bad = ServerInput.validate("https://host", "ABC", false) as ServerInputResult.Invalid
        assertNull(bad.urlError)
        assertNotNull(bad.tokenError)
        assertTrue(ServerInput.validate("https://host", "A".repeat(64), false) is ServerInputResult.Invalid)
        assertTrue(ServerInput.validate("https://host", " $token\n", false) is ServerInputResult.Valid)
    }

    @Test fun configNeverPrintsTheToken() {
        assertFalse(valid("https://host").toString().contains(token))
    }
}
