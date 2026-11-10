package dev.crazyagent.remote.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.crazyagent.remote.app.LiveImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

/** Pure layout and zoom rules for the live view, kept free of Compose for unit tests. */
internal object LiveViewMath {
    /** Space the header, a few chat rows, and the composer need below the live view. */
    const val RESERVED_DP = 300f
    const val MIN_PANE_DP = 96f
    const val MAX_ZOOM = 8f
    const val DOUBLE_TAP_ZOOM = 2.5f
    private const val MAX_PIXELS = 12_000_000L
    private const val MAX_SIDE = 8_192

    /**
     * Height for a full-width pane showing an image of [aspect] (width/height).
     * A normal browser viewport gets its exact height; a tall capture is capped
     * so the chat and composer keep room, and letterboxed inside the pane.
     * Returns null when there is no room at all (for example a small phone
     * with the keyboard open).
     */
    fun paneHeightDp(widthDp: Float, availableHeightDp: Float, aspect: Float): Float? {
        if (widthDp <= 0f || aspect <= 0f || !aspect.isFinite()) return null
        val cap = min(availableHeightDp * 0.5f, availableHeightDp - RESERVED_DP)
        if (cap < MIN_PANE_DP) return null
        return min(widthDp / aspect, cap).coerceAtLeast(MIN_PANE_DP)
    }

    /** Side-by-side layout: only when the window is clearly wider than tall. */
    fun sideBySide(widthDp: Float, heightDp: Float): Boolean = widthDp >= 560f && widthDp > heightDp * 1.2f

    /** Largest pan that still keeps the zoomed image covering the viewport edge. */
    fun maxPan(box: Float, fitted: Float, scale: Float): Float = max(0f, (fitted * scale - box) / 2f)

    /**
     * How old the capture is, from its ISO timestamp. Null when the time is
     * missing or unreadable; a clock that is slightly behind reads "just now".
     */
    fun ageLabel(capturedAt: String?, nowMs: Long): String? {
        val at = try {
            java.time.Instant.parse(capturedAt ?: return null).toEpochMilli()
        } catch (_: Exception) {
            return null
        }
        val seconds = (nowMs - at) / 1000
        return when {
            seconds < 10 -> "just now"
            seconds < 60 -> "${seconds}s ago"
            seconds < 3_600 -> "${seconds / 60}m ago"
            seconds < 86_400 -> "${seconds / 3_600}h ago"
            else -> "${seconds / 86_400}d ago"
        }
    }

    /** Who took the capture, so an old agent view is not mistaken for a fresh one. */
    fun sourceLabel(source: String?): String = when (source) {
        "manual" -> "Your capture"
        "help" -> "Where the agent is stuck"
        else -> "Agent view"
    }

    /** Caption under the live view: source and age. */
    fun caption(source: String?, capturedAt: String?, nowMs: Long): String =
        listOfNotNull(sourceLabel(source), ageLabel(capturedAt, nowMs)).joinToString(" · ")

    /** Power-of-two downsample so a huge full-page capture cannot exhaust memory. */
    fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        while ((width / sample).toLong() * (height / sample) > MAX_PIXELS || max(width, height) / sample > MAX_SIDE) sample *= 2
        return sample
    }
}

/**
 * Decode the downloaded screenshot off the main thread. The previous bitmap
 * stays on screen until the next one is ready, so the pane never flashes.
 */
@Composable
internal fun rememberLiveBitmap(image: LiveImage?): ImageBitmap? {
    var bitmap by remember { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(image?.id) {
        if (image == null) {
            bitmap = null
        } else {
            withContext(Dispatchers.Default) { decode(image.bytes) }?.let { bitmap = it }
        }
    }
    return bitmap
}

private fun decode(bytes: ByteArray): ImageBitmap? = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        null
    } else {
        val options = BitmapFactory.Options().apply { inSampleSize = LiveViewMath.sampleSize(bounds.outWidth, bounds.outHeight) }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }
} catch (_: Exception) {
    null
} catch (_: OutOfMemoryError) {
    null
}

/** Slim bar shown in place of a collapsed live view; tap to open it again. */
@Composable
internal fun LiveCollapsedBar(loading: Boolean, onExpand: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(AgentPanel)
            .clickable(onClickLabel = "Show live view", role = Role.Button, onClick = onExpand)
            .padding(horizontal = 20.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AnimatedVisibility(loading, enter = fadeIn(Motion.fast()), exit = fadeOut(Motion.fast())) {
            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = AgentYellow)
        }
        Text("Live view hidden", style = MaterialTheme.typography.labelMedium, color = AgentMuted, modifier = Modifier.weight(1f))
        Text("Show", style = MaterialTheme.typography.labelMedium, color = AgentYellow)
        Icon(AppIcons.Chevron, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(14.dp))
    }
}

/**
 * Slim bar for when there is nothing to show: no capture yet in this chat, or
 * the newest one is gone. Its button asks for a fresh capture.
 */
@Composable
internal fun LiveEmptyBar(message: String, canCapture: Boolean, capturing: Boolean, onCapture: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(AgentPanel)
            .clickable(enabled = canCapture, onClickLabel = "Capture the screen", role = Role.Button, onClick = onCapture)
            .padding(horizontal = 20.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(message, style = MaterialTheme.typography.labelMedium, color = AgentMuted, modifier = Modifier.weight(1f))
        if (capturing) {
            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp, color = AgentYellow)
        } else {
            Text("Capture", style = MaterialTheme.typography.labelMedium, color = if (canCapture) AgentYellow else AgentFaint)
            Icon(AppIcons.Refresh, contentDescription = null, tint = if (canCapture) AgentYellow else AgentFaint, modifier = Modifier.size(14.dp))
        }
    }
}

/**
 * The latest screenshot, edge to edge. Tap opens the zoomable viewer; the
 * chevron collapses it; the refresh button asks for a fresh capture. The
 * caption says whose capture it is and how old, or that the newest is gone.
 */
@Composable
internal fun LivePane(
    bitmap: ImageBitmap,
    loading: Boolean,
    modifier: Modifier = Modifier,
    caption: String? = null,
    stale: Boolean = false,
    canCapture: Boolean = false,
    capturing: Boolean = false,
    onCapture: () -> Unit = {},
    onCollapse: () -> Unit,
    onOpen: () -> Unit,
) {
    Box(
        modifier
            .background(Color.Black)
            .clickable(onClickLabel = "View full screen", role = Role.Image, onClick = onOpen),
    ) {
        Crossfade(targetState = bitmap, animationSpec = Motion.base(), label = "live-image", modifier = Modifier.fillMaxSize()) { shown ->
            Image(
                shown,
                contentDescription = "Latest browser screenshot",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        }
        AnimatedVisibility(loading, modifier = Modifier.align(Alignment.TopStart), enter = fadeIn(Motion.fast()), exit = fadeOut(Motion.fast())) {
            CircularProgressIndicator(
                Modifier.padding(8.dp).size(14.dp),
                strokeWidth = 2.dp,
                color = AgentYellow,
            )
        }
        Surface(
            shape = CircleShape,
            color = Color.Black.copy(alpha = 0.55f),
            modifier = Modifier.align(Alignment.TopEnd).padding(4.dp),
        ) {
            IconButton(onClick = onCollapse, modifier = Modifier.size(36.dp)) {
                Icon(AppIcons.Chevron, contentDescription = "Hide live view", tint = Color.White, modifier = Modifier.size(16.dp).rotate(180f))
            }
        }
        Surface(
            shape = CircleShape,
            color = Color.Black.copy(alpha = 0.55f),
            modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp),
        ) {
            Icon(AppIcons.Expand, contentDescription = null, tint = Color.White, modifier = Modifier.padding(6.dp).size(14.dp))
        }
        Surface(
            shape = CircleShape,
            color = Color.Black.copy(alpha = 0.6f),
            modifier = Modifier.align(Alignment.BottomStart).padding(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onCapture, enabled = canCapture && !capturing, modifier = Modifier.size(36.dp)) {
                    Crossfade(targetState = capturing, animationSpec = Motion.fast(), label = "capture-icon") { busy ->
                        if (busy) {
                            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = AgentYellow)
                        } else {
                            Icon(
                                AppIcons.Refresh,
                                contentDescription = if (canCapture) "Capture the screen now" else "A fresh capture is not available right now",
                                tint = if (canCapture) Color.White else Color.White.copy(alpha = 0.35f),
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }
                val text = if (stale) "Newest capture unavailable" else caption
                if (text != null) {
                    SmoothText(
                        text,
                        MaterialTheme.typography.labelSmall,
                        if (stale) AgentYellow else Color.White.copy(alpha = 0.85f),
                        modifier = Modifier.padding(end = 12.dp),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/**
 * Full-screen viewer: pinch to zoom around the fingers, drag to pan, double
 * tap to zoom in or reset. It keeps following new screenshots, and keeps the
 * current zoom while their size is unchanged.
 */
@Composable
internal fun LiveViewer(bitmap: ImageBitmap, loading: Boolean, onClose: () -> Unit) {
    val shape = bitmap.width to bitmap.height
    var scale by remember(shape) { mutableFloatStateOf(1f) }
    var offset by remember(shape) { mutableStateOf(Offset.Zero) }
    var box by remember { mutableStateOf(IntSize.Zero) }

    fun clamp(candidate: Offset, atScale: Float): Offset {
        if (box.width == 0 || box.height == 0) return Offset.Zero
        val fit = min(box.width.toFloat() / bitmap.width, box.height.toFloat() / bitmap.height)
        val maxX = LiveViewMath.maxPan(box.width.toFloat(), bitmap.width * fit, atScale)
        val maxY = LiveViewMath.maxPan(box.height.toFloat(), bitmap.height * fit, atScale)
        return Offset(candidate.x.coerceIn(-maxX, maxX), candidate.y.coerceIn(-maxY, maxY))
    }

    /** Zoom to [target] keeping the content under [focus] (viewport pixels) in place. */
    fun zoomTo(target: Float, focus: Offset, pan: Offset = Offset.Zero) {
        val next = target.coerceIn(1f, LiveViewMath.MAX_ZOOM)
        val ratio = next / scale
        val fromCenter = focus - Offset(box.width / 2f, box.height / 2f)
        offset = clamp(offset * ratio + fromCenter * (1f - ratio) + pan, next)
        scale = next
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Box(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .clipToBounds()
                .onSizeChanged { box = it }
                .pointerInput(shape) {
                    detectTransformGestures { centroid, pan, zoom, _ -> zoomTo(scale * zoom, centroid, pan) }
                }
                .pointerInput(shape) {
                    detectTapGestures(onDoubleTap = { tap ->
                        if (scale > 1.01f) {
                            scale = 1f
                            offset = Offset.Zero
                        } else {
                            zoomTo(LiveViewMath.DOUBLE_TAP_ZOOM, tap)
                        }
                    })
                },
        ) {
            Image(
                bitmap,
                contentDescription = "Browser screenshot. Pinch to zoom, double tap to zoom in or reset.",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
            )
        }
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            if (loading) {
                CircularProgressIndicator(
                    Modifier.align(Alignment.TopStart).padding(18.dp).size(16.dp),
                    strokeWidth = 2.dp,
                    color = AgentYellow,
                )
            }
            Surface(
                shape = CircleShape,
                color = Color.Black.copy(alpha = 0.6f),
                border = BorderStroke(1.dp, Color.White.copy(alpha = 0.25f)),
                modifier = Modifier.align(Alignment.TopEnd).padding(10.dp),
            ) {
                IconButton(onClick = onClose, modifier = Modifier.size(40.dp)) {
                    Icon(AppIcons.Close, contentDescription = "Close full screen view", tint = Color.White, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}
