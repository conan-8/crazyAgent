package dev.crazyagent.remote.app

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.graphics.scale
import dev.crazyagent.remote.data.PromptImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * Turns picked images into prompt attachments within the companion's limits
 * (`companion/prompt.mjs`): PNG/JPEG/WebP/GIF, ≤5 MB each, ≤12 MB total, ≤4.
 * Oversized or unsupported images are re-encoded as JPEG (long edge ≤2048 px).
 */
object ImagePreparer {
    const val MAX_IMAGE_BYTES = 5_000_000
    const val MAX_TOTAL_BYTES = 12_000_000
    private const val MAX_READ_BYTES = 40_000_000
    private const val MAX_EDGE_PX = 2048
    private val ACCEPTED = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    data class Prepared(val images: List<PromptImage>, val problem: String?)

    suspend fun prepare(resolver: ContentResolver, uris: List<Uri>, existing: List<PromptImage>): Prepared = withContext(Dispatchers.IO) {
        val room = RemoteController.MAX_IMAGES - existing.size
        var total = existing.sumOf { it.bytes.size.toLong() }
        val out = mutableListOf<PromptImage>()
        var problem: String? = if (uris.size > room) "Up to ${RemoteController.MAX_IMAGES} images per message." else null
        for (uri in uris.take(room.coerceAtLeast(0))) {
            val index = existing.size + out.size + 1
            val image = try {
                load(resolver, uri, index)
            } catch (_: Exception) {
                null
            }
            if (image == null) {
                problem = "One image couldn't be read or is too large."
                continue
            }
            if (total + image.bytes.size > MAX_TOTAL_BYTES) {
                problem = "Images can total at most 12 MB."
                continue
            }
            total += image.bytes.size
            out += image
        }
        Prepared(out, problem)
    }

    private fun load(resolver: ContentResolver, uri: Uri, index: Int): PromptImage? {
        val mime = resolver.getType(uri)
        val bytes = resolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(chunk)
                if (read < 0) break
                buffer.write(chunk, 0, read)
                if (buffer.size() > MAX_READ_BYTES) return null
            }
            buffer.toByteArray()
        } ?: return null
        if (mime in ACCEPTED && bytes.size <= MAX_IMAGE_BYTES) {
            return PromptImage("phone-image-$index.${extension(mime!!)}", mime, bytes)
        }
        val jpeg = reencode(bytes) ?: return null
        return PromptImage("phone-image-$index.jpg", "image/jpeg", jpeg)
    }

    private fun reencode(bytes: ByteArray): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE_PX * 2) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val scale = MAX_EDGE_PX.toFloat() / maxOf(decoded.width, decoded.height)
        val bitmap = if (scale < 1f) {
            decoded.scale((decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1))
        } else decoded
        for (quality in intArrayOf(85, 70, 55)) {
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= MAX_IMAGE_BYTES) return out.toByteArray()
        }
        return null
    }

    private fun extension(mime: String) = when (mime) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> "jpg"
    }
}
