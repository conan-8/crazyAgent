package dev.crazyagent.remote.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Tolerant accessors over [JsonObject]. Wire frames are parsed as untyped JSON
 * so a malformed or newer frame can be skipped instead of crashing the app.
 */
internal val RemoteJson = Json { ignoreUnknownKeys = true }

internal fun parseObject(text: String): JsonObject? = try {
    RemoteJson.parseToJsonElement(text) as? JsonObject
} catch (_: Exception) {
    null
}

internal fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonObject.long(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

internal fun JsonObject.int(key: String): Int? = long(key)?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

internal fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray

internal fun JsonElement?.asObject(): JsonObject? = this as? JsonObject

internal fun jsonString(value: String?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)
