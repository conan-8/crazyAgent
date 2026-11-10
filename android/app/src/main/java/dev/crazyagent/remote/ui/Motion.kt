package dev.crazyagent.remote.ui

import android.view.WindowManager
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Shared timing, matching the side panel: quick, but always visible as movement. */
internal object Motion {
    const val FAST = 120
    const val BASE = 180
    const val SLOW = 240
    val Ease = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    fun <T> fast(): FiniteAnimationSpec<T> = tween(FAST, easing = Ease)
    fun <T> base(): FiniteAnimationSpec<T> = tween(BASE, easing = Ease)
    fun <T> slow(): FiniteAnimationSpec<T> = tween(SLOW, easing = Ease)

    val rowEnter: EnterTransition = fadeIn(base()) + expandVertically(slow())
    val rowExit: ExitTransition = fadeOut(fast()) + shrinkVertically(base())
}

/**
 * Fades a new item into a LazyColumn. Placement and fade-out stay off on
 * purpose: those keep snapshots of departed rows and draw them outside the
 * list's clip, and on a real phone a resync left them stuck over the header
 * and over newer rows. The tail glide already makes arrivals move smoothly.
 */
@Composable
internal fun LazyItemScope.SmoothItem(content: @Composable () -> Unit) {
    Box(
        Modifier.animateItem(
            fadeInSpec = tween(Motion.BASE, easing = Motion.Ease),
            placementSpec = null,
            fadeOutSpec = null,
        ),
    ) { content() }
}

/**
 * Glide the list to [index] once the newest item has been laid out. A far jump,
 * such as the first load of a long chat, goes straight there. A drag cancels
 * the glide without ending the caller's collection.
 */
internal suspend fun LazyListState.glideToItem(index: Int) {
    withFrameNanos { }
    val lastVisible = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
    try {
        if (index - lastVisible > 3) scrollToItem(index) else animateScrollToItem(index)
    } catch (_: CancellationException) {
        currentCoroutineContext().ensureActive()
    }
}

/** Remembers the last non-null value, so content can stay drawn while it animates away. */
private class Retained<T : Any> { var value: T? = null }

@Composable
internal fun <T : Any> rememberLastNonNull(value: T?): T? {
    val retained = remember { Retained<T>() }
    if (value != null) retained.value = value
    return retained.value
}

/** Grows and fades [content] in when [value] appears; keeps the last value on screen while it leaves. */
@Composable
internal fun <T : Any> SmoothPresence(value: T?, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    val shown = rememberLastNonNull(value)
    AnimatedVisibility(visible = value != null, modifier = modifier, enter = Motion.rowEnter, exit = Motion.rowExit) {
        shown?.let { content(it) }
    }
}

/** Runs the enter transition once when first composed, for rows added to a plain Column. */
@Composable
internal fun EnterOnce(content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(false).apply { targetState = true } }
    AnimatedVisibility(visibleState = state, enter = Motion.rowEnter) { content() }
}

/** Text whose words crossfade when they change. */
@Composable
internal fun SmoothText(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
) {
    AnimatedContent(
        targetState = text,
        modifier = modifier,
        transitionSpec = {
            (fadeIn(tween(Motion.BASE, delayMillis = 40, easing = Motion.Ease)) togetherWith fadeOut(Motion.fast()))
                .using(SizeTransform(clip = false) { _: IntSize, _: IntSize -> Motion.base() })
        },
        label = "smooth-text",
    ) { words ->
        Text(words, style = style, color = color, maxLines = maxLines, overflow = overflow)
    }
}

/**
 * A full-screen dialog that fades and lifts in, and fades out when [value]
 * becomes null, however it was closed. The window's own dim and animation are
 * off, so the content's motion is the only thing the user sees.
 */
@Composable
internal fun <T : Any> SmoothFullScreenDialog(value: T?, onDismiss: () -> Unit, content: @Composable (T) -> Unit) {
    val retained = remember { Retained<T>() }
    if (value != null) retained.value = value
    var mounted by remember { mutableStateOf(value != null) }
    val progress = remember { Animatable(0f) }
    val open = value != null
    if (open) mounted = true
    LaunchedEffect(open) {
        if (open) {
            progress.animateTo(1f, Motion.slow())
        } else {
            progress.animateTo(0f, Motion.fast())
            mounted = false
            retained.value = null
        }
    }
    val current = retained.value
    if (!mounted || current == null) return
    Dialog(
        onDismissRequest = { if (open) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            window?.setWindowAnimations(0)
        }
        Box(
            Modifier.fillMaxSize().graphicsLayer {
                alpha = progress.value
                translationY = (1f - progress.value) * 14.dp.toPx()
            },
        ) { content(current) }
    }
}
