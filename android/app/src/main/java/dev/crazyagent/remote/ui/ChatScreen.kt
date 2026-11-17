package dev.crazyagent.remote.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.crazyagent.remote.app.LinkStatus
import dev.crazyagent.remote.app.PendingPhase
import dev.crazyagent.remote.app.PendingPrompt
import dev.crazyagent.remote.app.UiState
import dev.crazyagent.remote.data.PromptImage
import dev.crazyagent.remote.notifications.PushState
import dev.crazyagent.remote.state.DisplayRow
import dev.crazyagent.remote.state.Draft
import dev.crazyagent.remote.state.Health
import dev.crazyagent.remote.state.MarathonPlanItem
import dev.crazyagent.remote.state.NoteKind
import dev.crazyagent.remote.state.WatchNotice
import dev.crazyagent.remote.state.activityLine
import dev.crazyagent.remote.state.displayRows
import dev.crazyagent.remote.state.marathonChipCopy
import dev.crazyagent.remote.state.planSummary
import dev.crazyagent.remote.state.watchKindLabel
import dev.crazyagent.remote.state.watchTitle
import kotlinx.coroutines.flow.conflate

class ChatActions(
    val onComposer: (String) -> Unit,
    val onSend: () -> Unit,
    val onStop: () -> Unit,
    val onNewChat: () -> Unit,
    val onPickImages: () -> Unit,
    val onRemoveImage: (Int) -> Unit,
    val onRetryPending: () -> Unit,
    val onResendPending: () -> Unit,
    val onEditPending: () -> Unit,
    val onDiscardPending: () -> Unit,
    val onDismissNotice: () -> Unit,
    val onReconnect: () -> Unit,
    val onEditPairing: () -> Unit,
    val onForget: () -> Unit,
    val onRefreshSessions: () -> Unit,
    val onOpenHistory: (String) -> Unit,
    val onCloseHistory: () -> Unit,
    val onResumeChat: (String) -> Unit,
    val onToggleMarathon: () -> Unit,
    val onCaptureScreen: () -> Unit,
    val onEnableNotifications: () -> Unit,
    val onConfirm: (String) -> Unit,
    /** Watch card: Steer… focuses the composer and says what sending will do. */
    val onWatchSteer: () -> Unit,
    /** Watch card: It's fine dismisses the alert and snoozes its kind. */
    val onWatchAck: () -> Unit,
    /** V7: Settings — send a test notification and show the route's answer. */
    val onSendTestPush: () -> Unit,
)

private enum class UtilityPanel { SETTINGS, DIAGNOSTICS, HISTORY }

/** What the checklist card renders: the live plan during a turn, the carried plan between turns. */
private data class ChecklistView(val revision: Int, val items: List<MarathonPlanItem>, val awaitingUser: Boolean)
private enum class Level { OK, WARN, BAD, UNKNOWN }
private enum class LiveSlot { NONE, OPEN, COLLAPSED, EMPTY }

@Composable
fun ChatScreen(state: UiState, actions: ChatActions) {
    var confirmNew by rememberSaveable { mutableStateOf(false) }
    var confirmForget by rememberSaveable { mutableStateOf(false) }
    var panel by rememberSaveable { mutableStateOf<UtilityPanel?>(null) }
    val rows = remember(state.chat.items) { displayRows(state.chat.items) }
    val listState = rememberLazyListState()
    val activity = activityLine(state.chat.turn, state.chat.phase)
    val empty = rows.isEmpty() && state.chat.draft == null && state.pending == null && activity == null
    val tail = rows.size + (if (state.chat.draft != null) 1 else 0) + (if (state.pending != null) 1 else 0) + (if (activity != null) 1 else 0)

    // One long-lived follower: a glide in progress finishes, then goes to wherever
    // the end has moved to, so streaming text does not restart it on every token.
    val currentTail by rememberUpdatedState(tail)
    val draftLength by rememberUpdatedState(state.chat.draft?.text?.length)
    LaunchedEffect(listState) {
        snapshotFlow { currentTail to draftLength }
            .conflate()
            .collect { (count, _) -> if (count > 0) listState.glideToItem(count - 1) }
    }

    LaunchedEffect(empty) {
        if (empty) actions.onRefreshSessions()
    }

    val liveBitmap = rememberLiveBitmap(state.liveImage)
    var viewerOpen by rememberSaveable { mutableStateOf(false) }
    var liveCollapsed by rememberSaveable { mutableStateOf(false) }
    // The carried plan's checklist keeps the user's collapse choice across updates.
    var planCollapsed by rememberSaveable { mutableStateOf(false) }
    // The watch card's Steer… focuses the composer without leaving the screen.
    val composerFocus = remember { FocusRequester() }
    // A coarse clock so the capture's age stays honest while the screen is open.
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(10_000)
            nowMs = System.currentTimeMillis()
        }
    }
    val liveCaption = state.liveImageMeta?.let { LiveViewMath.caption(it.source, it.capturedAt, nowMs) }

    // Header, live-view slot, chat, and composer. In a wide window the open
    // live view sits beside this column instead of in the slot.
    val body: @Composable ColumnScope.(@Composable () -> Unit) -> Unit = { liveSlot ->
        Header(
            state = state,
            onNew = { confirmNew = true },
            onHistory = {
                actions.onRefreshSessions()
                panel = UtilityPanel.HISTORY
            },
            onDiagnostics = { panel = UtilityPanel.DIAGNOSTICS },
            onSettings = { panel = UtilityPanel.SETTINGS },
        )
        liveSlot()
        StatusLine(state, onClick = { panel = UtilityPanel.DIAGNOSTICS })
        LinkBanner(state, actions)
        SmoothPresence(state.notice) { Banner(it, "Dismiss", actions.onDismissNotice, danger = false) }
        SmoothPresence(healthIssue(state)) { Banner(it, "Details", { panel = UtilityPanel.DIAGNOSTICS }, danger = true) }
        AnimatedVisibility(state.historyLoading, enter = Motion.rowEnter, exit = Motion.rowExit) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = AgentYellow)
                Text("Loading saved chat…", style = AgentType.Meta, color = AgentMuted)
            }
        }
        Crossfade(targetState = empty, animationSpec = Motion.base(), label = "chat-body", modifier = Modifier.weight(1f).fillMaxWidth()) { isEmpty ->
            if (isEmpty) {
                EmptyState(
                    state = state,
                    onOpenHistory = actions.onOpenHistory,
                    onViewAll = {
                        actions.onRefreshSessions()
                        panel = UtilityPanel.HISTORY
                    },
                )
            } else {
                LazyColumn(
                    state = listState,
                    // Nothing a row draws may leave the list's own area.
                    modifier = Modifier.fillMaxSize().clipToBounds(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    items(rows, key = { it.key }) { row -> SmoothItem { RowView(row) } }
                    state.chat.draft?.let { draft -> item(key = "draft:${draft.streamId}") { SmoothItem { DraftView(draft) } } }
                    state.pending?.let { pending -> item(key = "pending:${pending.clientMessageId}") { SmoothItem { PendingView(pending, state, actions) } } }
                    activity?.let { line ->
                        item(key = "activity") {
                            SmoothItem {
                                // The current action, in the yellow of a running step's title.
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                                    modifier = Modifier.heightIn(min = 28.dp).semantics { liveRegion = LiveRegionMode.Polite },
                                ) {
                                    CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = AgentYellow, trackColor = AgentYellow.copy(alpha = 0.2f))
                                    SmoothText(line, AgentType.Step, AgentYellow)
                                }
                            }
                        }
                    }
                }
            }
        }
        SmoothPresence(state.chat.help?.takeIf { state.chat.turn.isWaiting }) { help ->
            HelpCard(
                help = help,
                // Only offer the view when the capture made for this request is the one on screen.
                canShowScreen = help.screenshotId != null && help.screenshotId == state.liveImage?.id,
                onShowScreen = { viewerOpen = true },
            )
        }
        SmoothPresence(state.chat.confirm?.takeIf { state.chat.turn.isWaiting }) { confirm ->
            ConfirmCard(
                confirm = confirm,
                canAnswer = state.canConfirm,
                canShowScreen = confirm.screenshotId != null && confirm.screenshotId == state.liveImage?.id,
                onShowScreen = { viewerOpen = true },
                onAnswer = actions.onConfirm,
            )
        }
        // M5: the watcher's notice — an open alert card with Stop / Steer… /
        // It's fine, collapsing to a summary line on recovery or dismissal.
        SmoothPresence(state.chat.watchNotice) { notice ->
            WatchCard(
                notice = notice,
                canStop = state.canStop,
                canSteer = state.link.status == LinkStatus.LIVE && state.chat.synced,
                canAck = state.canAckWatch,
                onStop = actions.onStop,
                onSteer = {
                    composerFocus.requestFocus()
                    actions.onWatchSteer()
                },
                onAck = actions.onWatchAck,
            )
        }
        // V6: the checklist renders the LIVE plan during the turn and the
        // carried plan between turns (the hub clears turn.plan at the end).
        val checklist = state.chat.turn.plan?.let { ChecklistView(it.revision, it.items, it.awaitingUser) }
            ?: state.chat.marathon.plan?.let { ChecklistView(it.revision, it.items, false) }
        SmoothPresence(checklist) { view ->
            PlanChecklistCard(view.revision, view.items, view.awaitingUser, collapsed = planCollapsed, onToggle = { planCollapsed = !planCollapsed })
        }
        Composer(
            state = state,
            actions = actions,
            highlight = empty,
            nowMs = nowMs,
            composerFocus = composerFocus,
            onSlashCommand = { command ->
                actions.onComposer("")
                when (command) {
                    "new" -> if (state.canStartNew) confirmNew = true
                    "model" -> if (!state.busy) panel = UtilityPanel.SETTINGS
                    // /plan resolves to this same command as an unlisted alias.
                    "marathon" -> if (state.canToggleMarathon) actions.onToggleMarathon()
                }
            },
        )
        // `.footer`: 9px on a 12px line.
        Text(
            "Shared with the desktop side panel",
            style = agentType(9f, 12f / 9f),
            color = AgentFooter,
            modifier = Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, bottom = 5.dp),
            textAlign = TextAlign.Center,
        )
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(AgentBackground).safeDrawingPadding()) {
        val bitmap = liveBitmap
        val beside = bitmap != null && !liveCollapsed && LiveViewMath.sideBySide(maxWidth.value, maxHeight.value)
        val paneHeight = bitmap?.let { LiveViewMath.paneHeightDp(maxWidth.value, maxHeight.value, it.width.toFloat() / it.height) }
        // Below the top icons: the open pane, or a slim bar to reopen it. The
        // slot keeps its place in the column, so the composer keeps focus.
        val slot = when {
            bitmap != null && liveCollapsed -> LiveSlot.COLLAPSED
            bitmap != null && !beside && paneHeight != null -> LiveSlot.OPEN
            bitmap == null && state.link.status == LinkStatus.LIVE && state.chat.synced && state.liveImage == null && !state.liveImageLoading -> LiveSlot.EMPTY
            else -> LiveSlot.NONE
        }
        val liveSlot: @Composable () -> Unit = {
            AnimatedContent(
                targetState = slot,
                transitionSpec = {
                    (fadeIn(Motion.base()) togetherWith fadeOut(Motion.fast())).using(SizeTransform(clip = true) { _, _ -> Motion.slow() })
                },
                label = "live-slot",
            ) { mode ->
                when (mode) {
                    LiveSlot.COLLAPSED -> LiveCollapsedBar(state.liveImageLoading) { liveCollapsed = false }
                    LiveSlot.OPEN -> if (bitmap != null && paneHeight != null) {
                        LivePane(
                            bitmap,
                            state.liveImageLoading,
                            Modifier.fillMaxWidth().height(paneHeight.dp),
                            caption = liveCaption,
                            stale = state.liveImageUnavailable,
                            canCapture = state.canCapture,
                            capturing = state.snapshotInFlight,
                            onCapture = actions.onCaptureScreen,
                            onCollapse = { liveCollapsed = true },
                            onOpen = { viewerOpen = true },
                        )
                    }
                    // Nothing on screen: say why, and offer a fresh capture.
                    LiveSlot.EMPTY -> LiveEmptyBar(
                        message = if (state.liveImageUnavailable) "The last screenshot is no longer available" else "No live view yet",
                        canCapture = state.canCapture,
                        capturing = state.snapshotInFlight,
                        onCapture = actions.onCaptureScreen,
                    )
                    LiveSlot.NONE -> Unit
                }
            }
        }
        if (bitmap != null && beside) {
            Row(Modifier.fillMaxSize()) {
                LivePane(
                    bitmap,
                    state.liveImageLoading,
                    Modifier.weight(1.15f).fillMaxHeight(),
                    caption = liveCaption,
                    stale = state.liveImageUnavailable,
                    canCapture = state.canCapture,
                    capturing = state.snapshotInFlight,
                    onCapture = actions.onCaptureScreen,
                    onCollapse = { liveCollapsed = true },
                    onOpen = { viewerOpen = true },
                )
                Column(Modifier.weight(1f).fillMaxHeight()) { body(liveSlot) }
            }
        } else {
            Column(Modifier.fillMaxSize()) { body(liveSlot) }
        }
    }

    SmoothFullScreenDialog(liveBitmap?.takeIf { viewerOpen }, onDismiss = { viewerOpen = false }) { bitmap ->
        LiveViewer(bitmap, state.liveImageLoading) { viewerOpen = false }
    }

    SmoothFullScreenDialog(panel, onDismiss = { panel = null }) { current ->
        UtilityDialog(
            panel = current,
            state = state,
            onDismiss = { panel = null },
            onReconnect = actions.onReconnect,
            onOpenHistory = { sessionId ->
                panel = null
                actions.onOpenHistory(sessionId)
            },
            onEditPairing = {
                panel = null
                actions.onEditPairing()
            },
            onForget = {
                panel = null
                confirmForget = true
            },
            onEnableNotifications = actions.onEnableNotifications,
            onSendTestPush = actions.onSendTestPush,
        )
    }
    SmoothFullScreenDialog(state.historyOpen, onDismiss = actions.onCloseHistory) { archived ->
        ArchivedChatDialog(
            chat = archived,
            isCurrent = archived.sessionId == state.chat.sessionId,
            canContinue = state.canStartNew,
            continuing = state.resumeInFlight,
            busy = state.busy,
            onContinue = { actions.onResumeChat(archived.sessionId) },
            onDismiss = actions.onCloseHistory,
        )
    }
    if (confirmNew) {
        AgentAlert(
            title = "Start a new chat?",
            text = "This starts a new session for the desktop side panel too.",
            confirm = "New chat",
            onConfirm = { confirmNew = false; actions.onNewChat() },
            onDismiss = { confirmNew = false },
        )
    }
    if (confirmForget) {
        AgentAlert(
            title = "Forget this pairing?",
            text = "The token is deleted from this phone. To also lock out a lost phone, rotate the token on the computer with --new-remote-token.",
            confirm = "Forget",
            danger = true,
            onConfirm = { confirmForget = false; actions.onForget() },
            onDismiss = { confirmForget = false },
        )
    }
}

@Composable
private fun Header(state: UiState, onNew: () -> Unit, onHistory: () -> Unit, onDiagnostics: () -> Unit, onSettings: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 10.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.Cursor, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(20.dp))
        Text("crazyAgent", style = AgentType.Title, color = AgentText, modifier = Modifier.padding(start = 9.dp).weight(1f))
        // `.top-actions`: the panel's glass pill of 34px icon buttons, laid out in a row here.
        Row(
            Modifier.background(AgentGlass, CircleShape).border(1.dp, AgentGlassBorder, CircleShape).padding(5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Crossfade(targetState = state.newInFlight, animationSpec = Motion.fast(), label = "new-chat-icon") { inFlight ->
                if (inFlight) {
                    Box(Modifier.size(34.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp, color = AgentYellow)
                    }
                } else {
                    AgentIconButton(AppIcons.Plus, "New chat", onNew, enabled = state.canStartNew)
                }
            }
            AgentIconButton(AppIcons.History, "Chat history", onHistory)
            AgentIconButton(AppIcons.Diagnostics, "Connection diagnostics", onDiagnostics)
            AgentIconButton(AppIcons.Settings, "Settings", onSettings)
        }
    }
}

/** `.activity-head`: a 6px state dot, the phase, and the quieter detail beside it. */
@Composable
private fun StatusLine(state: UiState, onClick: () -> Unit) {
    val activity = activityLine(state.chat.turn, state.chat.phase)
    val label = activity ?: when (state.link.status) {
        LinkStatus.LIVE -> if (!state.chat.synced) "Syncing chat…" else if (state.chat.turn.isWaiting) "Waiting for you" else "Connected"
        LinkStatus.CONNECTING -> "Connecting…"
        LinkStatus.RECONNECTING -> "Reconnecting…"
        LinkStatus.PAUSED -> "Paused"
        LinkStatus.AUTH_FAILED -> "Token rejected"
        LinkStatus.HOST_REJECTED -> "Address rejected"
    }
    val target = when {
        state.busy -> AgentYellow
        state.link.status == LinkStatus.LIVE && state.chat.synced && state.chat.turn.isWaiting -> AgentYellow
        state.link.status == LinkStatus.LIVE && state.chat.synced -> AgentGreen
        state.link.status == LinkStatus.AUTH_FAILED || state.link.status == LinkStatus.HOST_REJECTED -> AgentDanger
        else -> AgentDim
    }
    val color by animateColorAsState(target, Motion.base(), label = "status-dot")
    val labelColor by animateColorAsState(if (activity != null) AgentYellow else AgentPhase, Motion.base(), label = "status-label")
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        SmoothText(label, AgentType.Meta, labelColor, maxLines = 1)
        Text(
            state.host,
            style = AgentType.Tiny,
            color = AgentDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun EmptyState(state: UiState, onOpenHistory: (String) -> Unit, onViewAll: () -> Unit) {
    Crossfade(targetState = state.chat.synced, animationSpec = Motion.base(), label = "empty-state", modifier = Modifier.fillMaxSize()) { synced ->
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (!synced) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(color = AgentYellow, modifier = Modifier.size(28.dp), strokeWidth = 2.dp, trackColor = AgentYellow.copy(alpha = 0.2f))
                    Text("Connecting to your companion…", style = AgentType.Meta, color = AgentMuted)
                }
            } else {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().animateContentSize(Motion.base()).verticalScroll(rememberScrollState()).padding(24.dp),
                ) {
                    RecentSessions(state.chat.sessions, onOpenHistory, onViewAll)
                }
            }
        }
    }
}

/** `.confirm-card`: the yellow-washed card above the composer while the chat waits for the user. */
@Composable
private fun RequestCard(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, bottom = 8.dp)
            .background(AgentYellowWash, shape)
            .border(1.dp, AgentYellow.copy(alpha = 0.4f), shape)
            .padding(12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(4.dp),
        content = content,
    )
}

private val RequestTitle = AgentType.Small.copy(fontWeight = FontWeight.SemiBold)
private val RequestDetail = agentType(11f, 1.4f)

/**
 * The agent's own structured request for the user. It offers no Approve/Deny:
 * the only way forward is an ordinary reply, which continues this chat.
 */
@Composable
private fun HelpCard(help: dev.crazyagent.remote.state.HelpRequest, canShowScreen: Boolean, onShowScreen: () -> Unit) {
    RequestCard {
        AgentBadge("Help")
        Text(dev.crazyagent.remote.state.helpTitle(help.category), style = RequestTitle, color = AgentYellow, modifier = Modifier.padding(top = 2.dp))
        SelectionContainer {
            Text(help.reason, style = AgentType.Note, color = AgentText, modifier = Modifier.heightIn(max = 120.dp).verticalScroll(rememberScrollState()))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                when {
                    help.screenshotId == null -> "No screenshot was captured. Reply below to continue."
                    canShowScreen -> "Reply below to continue."
                    else -> "Its screenshot is no longer shown. Reply below to continue."
                },
                style = RequestDetail,
                color = AgentMuted,
                modifier = Modifier.weight(1f),
            )
            if (canShowScreen) AgentLink("Show screen", onShowScreen)
        }
    }
}

/**
 * The opt-in irreversible-action confirmation (B9b). Approve/Deny sends the
 * decision as the next message; the companion writes the decision block. An
 * ordinary reply abandons the request instead, exactly as on the desktop.
 */
@Composable
private fun ConfirmCard(
    confirm: dev.crazyagent.remote.state.ConfirmRequest,
    canAnswer: Boolean,
    canShowScreen: Boolean,
    onShowScreen: () -> Unit,
    onAnswer: (String) -> Unit,
) {
    RequestCard {
        AgentBadge("Approval")
        Text("Waiting for your approval", style = RequestTitle, color = AgentYellow, modifier = Modifier.padding(top = 2.dp))
        SelectionContainer {
            Text(confirm.action, style = AgentType.Note, color = AgentText, modifier = Modifier.heightIn(max = 120.dp).verticalScroll(rememberScrollState()))
        }
        Text("Target: ${confirm.target}", style = RequestDetail, color = AgentMuted)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                when {
                    confirm.screenshotId == null -> "No screenshot was captured."
                    canShowScreen -> "Approve only if this is what you want."
                    else -> "Its screenshot is no longer shown."
                },
                style = RequestDetail,
                color = AgentMuted,
                modifier = Modifier.weight(1f),
            )
            if (canShowScreen) AgentLink("Show screen", onShowScreen)
        }
        // `.confirm-card-actions`: right-aligned, 10px below the copy.
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            AgentButton("Deny", { onAnswer("deny") }, enabled = canAnswer, modifier = Modifier.defaultMinSize(minWidth = 84.dp))
            AgentButton("Approve", { onAnswer("approve") }, primary = true, enabled = canAnswer, modifier = Modifier.defaultMinSize(minWidth = 84.dp))
        }
    }
}

/**
 * M5: the marathon watcher's notice, modeled on the help card. An open
 * actionable alert (hard signal, judge stuck/blocked, or ended-incomplete)
 * shows the reason and Stop / Steer… / It's fine; recovered/dismissed notices
 * collapse to a quiet summary line. Stop is the ordinary Stop; Steer… focuses
 * the composer; It's fine acks the alert and snoozes its kind for 15 minutes.
 */
@Composable
private fun WatchCard(
    notice: WatchNotice,
    canStop: Boolean,
    canSteer: Boolean,
    canAck: Boolean,
    onStop: () -> Unit,
    onSteer: () -> Unit,
    onAck: () -> Unit,
) {
    if (!notice.actionable) {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 8.dp).heightIn(min = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            val color = if (notice.kind == "recovered") AgentGreen else AgentDim
            Box(Modifier.size(6.dp).background(color, CircleShape))
            Text(
                "${watchKindLabel(notice.kind)} — ${notice.reason.ifEmpty { watchKindLabel(notice.kind) }}",
                style = AgentType.Note,
                color = AgentMuted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        return
    }
    RequestCard {
        AgentBadge(watchKindLabel(notice.kind))
        Text(watchTitle(notice.kind), style = RequestTitle, color = AgentYellow, modifier = Modifier.padding(top = 2.dp))
        SelectionContainer {
            Text(
                notice.reason.ifEmpty { watchKindLabel(notice.kind) },
                style = AgentType.Note,
                color = AgentText,
                modifier = Modifier.heightIn(max = 120.dp).verticalScroll(rememberScrollState()),
            )
        }
        Text(
            if (notice.kind == "ended-incomplete") {
                "Steer to continue the work, or dismiss this notice."
            } else {
                "Stop ends the turn. Steer redirects it. It's fine snoozes this kind of alert for 15 minutes."
            },
            style = RequestDetail,
            color = AgentMuted,
        )
        // `.watch-row-actions`: Stop carries the panel's red border/text.
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            AgentButton("Stop", onStop, danger = true, enabled = canStop)
            AgentButton("Steer…", onSteer, enabled = canSteer)
            AgentButton("It's fine", onAck, primary = true, enabled = canAck)
        }
    }
}

/**
 * The marathon checklist as a collapsible card. V6: during a turn it renders
 * the LIVE plan (`remote.plan`); between turns, the carried plan
 * (`remote.marathon`). Statuses mirror the provider's plan: pending,
 * in_progress, completed, blocked.
 */
@Composable
private fun PlanChecklistCard(revision: Int, items: List<MarathonPlanItem>, awaitingUser: Boolean, collapsed: Boolean, onToggle: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    val chevronAngle by animateFloatAsState(if (collapsed) -90f else 0f, Motion.base(), label = "plan-chevron")
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, bottom = 8.dp)
            .background(AgentPanel, shape)
            .border(1.dp, AgentBorder, shape),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onToggle)
                .padding(horizontal = 12.dp, vertical = 9.dp)
                .semantics { contentDescription = "Marathon plan, ${planSummary(revision, items)}. Tap to ${if (collapsed) "expand" else "collapse"}." },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text("Marathon plan", style = AgentType.Step, color = AgentStepTitle)
            Text(
                planSummary(revision, items),
                style = AgentType.Meta,
                color = AgentMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
            Icon(AppIcons.Chevron, contentDescription = if (collapsed) "Expand" else "Collapse", tint = AgentSubtle, modifier = Modifier.size(12.dp).rotate(chevronAngle))
        }
        AnimatedVisibility(!collapsed, enter = Motion.rowEnter, exit = Motion.rowExit) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                for (item in items) {
                    val (dot, text) = when (item.status) {
                        "completed" -> AgentGreen to AgentMuted
                        "in_progress" -> AgentYellow to AgentText
                        "blocked" -> AgentDanger to AgentDanger
                        else -> AgentDim to AgentLabel
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(6.dp).background(dot, CircleShape))
                            Text(
                                item.content,
                                style = AgentType.Note,
                                color = text,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        // V8 (§3.9): the blocked-item reason under the content,
                        // mirroring the panel's .plan-panel-item-reason (muted
                        // italic 11px, line-height 1.4, content column).
                        if (item.status == "blocked" && item.reason != null) {
                            Text(
                                item.reason,
                                style = AgentType.Note.copy(fontSize = 11.sp, lineHeight = 15.4.sp, fontStyle = FontStyle.Italic),
                                color = AgentMuted,
                                modifier = Modifier.padding(start = 14.dp),
                            )
                        }
                    }
                }
                if (awaitingUser) {
                    Text("Waiting for your reply", style = AgentType.Tiny, color = AgentYellow)
                }
            }
        }
    }
}

@Composable
private fun LinkBanner(state: UiState, actions: ChatActions) {
    val link = state.link
    val banner = when (link.status) {
        LinkStatus.AUTH_FAILED -> Triple(link.detail ?: "The token was rejected.", "Pair again", actions.onEditPairing)
        LinkStatus.HOST_REJECTED -> Triple(link.detail ?: "The server refused this address.", "Retry", actions.onReconnect)
        LinkStatus.RECONNECTING -> Triple(link.detail ?: "Reconnecting…", "Retry now", actions.onReconnect)
        else -> null
    }
    SmoothPresence(banner) { (message, label, action) -> Banner(message, label, action, danger = true) }
}

private fun healthIssue(state: UiState): String? {
    if (state.link.status != LinkStatus.LIVE || !state.chat.synced) return null
    val health = state.chat.health
    return when {
        health.uiConnected == false -> "The browser extension is not connected. Is Edge running? Browser actions cannot run."
        // After a Stop the runtime is torn down on purpose and its tools reconnect when the
        // next turn starts, so idle + ready is not a fault. Mid-turn it is.
        health.toolsConnected == false && (state.busy || health.dsh != "ready") -> "The browser tools are offline. Browser actions cannot run."
        health.dsh != null && health.dsh != "ready" && health.dsh != "starting" -> health.dshMessage ?: "The model runtime is not ready."
        else -> null
    }
}

/** `.banner`: 12px text beside a `.link`, whose touch padding takes the place of part of the row's own. */
@Composable
private fun Banner(message: String, actionLabel: String, onAction: () -> Unit, danger: Boolean) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, bottom = 8.dp)
            .background(if (danger) Color(0xFF241919) else AgentYellowWash, shape)
            .border(1.dp, (if (danger) AgentDanger else AgentYellow).copy(alpha = 0.25f), shape)
            .padding(start = 12.dp, end = 6.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            message,
            style = AgentType.Note,
            color = AgentBannerText,
            modifier = Modifier.weight(1f).padding(vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite },
        )
        AgentLink(actionLabel, onAction)
    }
}

@Composable
internal fun RowView(row: DisplayRow) {
    when (row) {
        is DisplayRow.User -> UserBubble(label = row.from.takeUnless { row.own }) {
            if (row.text.isNotEmpty()) SelectionContainer { Text(row.text, style = AgentType.Bubble, color = AgentText) }
            if (row.imageCount > 0) Text(if (row.imageCount == 1) "1 image" else "${row.imageCount} images", style = AgentType.Meta, color = AgentMuted)
        }
        // `.activity-answer`
        is DisplayRow.Assistant -> SelectionContainer(Modifier.padding(top = 6.dp, bottom = 4.dp)) {
            MarkdownContent(row.text)
        }
        is DisplayRow.Tool -> ToolView(row)
        // The end of a turn: the panel's `.agent-turn-summary` line, and its 22px gap before the next turn.
        is DisplayRow.Note -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            modifier = Modifier.padding(bottom = 19.dp).heightIn(min = 26.dp),
        ) {
            val color = when (row.kind) {
                NoteKind.ERROR -> AgentDanger
                NoteKind.DONE -> AgentGreen
                NoteKind.STOPPED -> AgentDim
            }
            Box(Modifier.size(6.dp).background(color, CircleShape))
            Text(row.text, style = AgentType.Step, color = if (row.kind == NoteKind.ERROR) AgentDanger else AgentMuted)
        }
    }
}

/**
 * `.activity-turn` + `.user-bubble`: right-aligned, at most 82% wide. [label]
 * is the panel's `.user-origin` pill, shown only when there is something to say.
 */
@Composable
private fun UserBubble(label: String?, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 16.dp)) {
        Spacer(Modifier.weight(0.18f))
        Box(Modifier.weight(0.82f), contentAlignment = Alignment.CenterEnd) {
            val shape = RoundedCornerShape(16.dp)
            Column(
                Modifier.background(AgentPanelRaised, shape).border(1.dp, AgentBorder, shape).padding(horizontal = 14.dp, vertical = 9.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                if (label != null) {
                    Box(Modifier.border(1.dp, AgentBorder, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 1.dp)) {
                        SmoothText(label, AgentType.Tiny.copy(letterSpacing = 0.02.em), AgentMuted)
                    }
                }
                content()
            }
        }
    }
}

/** `.activity-step`: a 28px head (icon, title, state, caret) over a body behind a dashed rule. */
@Composable
private fun ToolView(row: DisplayRow.Tool) {
    var open by remember { mutableStateOf(false) }
    val running = row.result == null
    val failed = row.result?.ok == false
    val status = when (row.result?.ok) {
        true -> "Done"
        false -> "Failed"
        null -> "Running"
    }
    val statusColor by animateColorAsState(
        when {
            running -> AgentYellow
            failed -> AgentDanger
            else -> AgentStepMeta
        },
        Motion.base(),
        label = "tool-status",
    )
    // The tool still running is the current action.
    val titleColor by animateColorAsState(
        when {
            running -> AgentYellow
            open -> AgentStepTitle
            else -> AgentLabel
        },
        Motion.base(),
        label = "tool-title",
    )
    val iconColor by animateColorAsState(
        when {
            running -> AgentYellow
            failed -> AgentDanger
            else -> AgentStepIcon
        },
        Motion.base(),
        label = "tool-icon",
    )
    val chevronAngle by animateFloatAsState(if (open) 0f else -90f, Motion.base(), label = "tool-chevron")
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 28.dp)
                .clip(RoundedCornerShape(6.dp))
                .clickable { open = !open }
                .semantics { contentDescription = "Tool ${row.name}, $status. Tap for details." },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(AppIcons.Tool, contentDescription = null, tint = iconColor, modifier = Modifier.size(17.dp))
            Text(toolTitle(row.name), style = AgentType.Step, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            SmoothText(status, AgentType.Meta, statusColor)
            Icon(AppIcons.Chevron, contentDescription = if (open) "Collapse" else "Expand", tint = AgentSubtle, modifier = Modifier.size(12.dp).rotate(chevronAngle))
        }
        AnimatedVisibility(open, enter = Motion.rowEnter, exit = Motion.rowExit) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp, bottom = 8.dp)
                    .heightIn(max = 240.dp)
                    .dashedStartRule()
                    .verticalScroll(rememberScrollState())
                    .padding(start = 17.dp, top = 2.dp, bottom = 2.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (row.args.isNotBlank()) Text(row.args.take(2_000), style = AgentType.Mono, color = AgentMuted)
                row.result?.text?.takeIf { it.isNotBlank() }?.let { Text(it.take(4_000), style = AgentType.Entry, color = if (failed) AgentDanger else AgentLabel) }
            }
        }
    }
}

private fun toolTitle(name: String): String = name
    .removePrefix("browser_")
    .replace('_', ' ')
    .replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }

@Composable
private fun DraftView(draft: Draft) {
    Column(Modifier.fillMaxWidth().animateContentSize(Motion.fast()).padding(top = 2.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val thinking = draft.text.isEmpty()
        // `.thinking-wait` until the first token, then a running step's title.
        SmoothText(
            if (thinking) "Thinking…" else "Responding",
            if (thinking) AgentType.Small.copy(lineHeight = 24.sp, letterSpacing = 0.01.em) else AgentType.Step,
            if (thinking) AgentThinking else AgentYellow,
        )
        Crossfade(targetState = draft.text.isNotEmpty(), animationSpec = Motion.base(), label = "draft-body") { hasText ->
            if (hasText) {
                SelectionContainer { MarkdownContent(draft.text) }
            } else if (draft.reasoning.isNotEmpty()) {
                Text(draft.reasoning.takeLast(400), style = AgentType.Entry, color = AgentMuted)
            }
        }
        for (tool in draft.tools) {
            key(tool.id) {
                EnterOnce {
                    Row(Modifier.heightIn(min = 28.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(AppIcons.Tool, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(17.dp))
                        Text("${toolTitle(tool.name ?: "tool")}…", style = AgentType.Step, color = AgentYellow)
                    }
                }
            }
        }
    }
}

@Composable
private fun PendingView(pending: PendingPrompt, state: UiState, actions: ChatActions) {
    UserBubble(label = when (pending.phase) {
        PendingPhase.SENDING -> "Sending…"
        PendingPhase.UNCERTAIN -> "Checking delivery…"
        PendingPhase.NEEDS_REVIEW -> "Not confirmed"
        PendingPhase.STEERING -> "Steering…"
    }) {
        Text(pending.text, style = AgentType.Bubble, color = AgentText)
        if (pending.imageCount > 0) Text(if (pending.imageCount == 1) "1 image" else "${pending.imageCount} images", style = AgentType.Meta, color = AgentMuted)
        SmoothPresence(pending.note) { Text(it, style = AgentType.Note, color = AgentYellow, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        AnimatedVisibility(pending.phase == PendingPhase.NEEDS_REVIEW, enter = Motion.rowEnter, exit = Motion.rowExit) {
            val sameInstance = pending.instanceId == state.chat.instanceId && pending.images.size == pending.imageCount
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (sameInstance) AgentLink("Retry", actions.onRetryPending)
                AgentLink("Send again", actions.onResendPending, enabled = state.link.status == LinkStatus.LIVE && !state.busy)
                AgentLink("Edit", actions.onEditPending)
                AgentLink("Discard", actions.onDiscardPending)
            }
        }
    }
}

@Composable
private fun Composer(state: UiState, actions: ChatActions, highlight: Boolean, nowMs: Long, composerFocus: FocusRequester, onSlashCommand: (String) -> Unit) {
    var showContext by rememberSaveable { mutableStateOf(false) }
    val contextWindow = state.chat.health.contextWindow?.takeIf { it > 0 }
    val contextTokens = (state.chat.health.contextTokens ?: 0).coerceAtLeast(0)
    val slashMatches = slashQuery(state.composer)?.let(::matchSlashCommands).orEmpty()
    SmoothPresence(slashMatches.takeIf { it.isNotEmpty() }) { matches ->
        SlashPalette(
            commands = matches,
            enabledFor = { command ->
                when (command.id) {
                    "new" -> state.canStartNew
                    "model" -> !state.busy
                    // The shared switch toggles mid-turn too (M5).
                    "marathon" -> state.canToggleMarathon
                    else -> false
                }
            },
            onSelect = { command -> onSlashCommand(command.id) },
        )
    }
    // The chip renders only the companion's state; it stays tappable while busy.
    AnimatedVisibility(state.chat.marathon.enabled, enter = Motion.rowEnter, exit = Motion.rowExit) {
        MarathonChip(
            copy = marathonChipCopy(state.chat.marathon, state.busy, nowMs),
            alert = state.chat.marathon.watch.open != null,
            enabled = state.canToggleMarathon,
            onToggle = actions.onToggleMarathon,
        )
    }
    val composerBorder by animateColorAsState(if (highlight) AgentYellow else AgentBorder, Motion.slow(), label = "composer-border")
    // `.composer` (0 12px 8px) around `.composer-field` (12px 10px 10px 14px, 6px between rows).
    val composerShape = RoundedCornerShape(20.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, bottom = 8.dp)
            .background(AgentPanel, composerShape)
            .border(1.dp, composerBorder, composerShape),
    ) {
        Column(Modifier.padding(start = 14.dp, end = 10.dp, top = 12.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SmoothPresence(state.attachments.takeIf { it.isNotEmpty() }) { attachments ->
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    attachments.forEachIndexed { index, image -> Attachment(image, index, actions.onRemoveImage) }
                }
            }
            val hint = when {
                state.link.status != LinkStatus.LIVE -> "Not connected"
                !state.runtimeReady -> "The model runtime is not ready"
                state.busy -> "Steer the agent: send to redirect this turn…"
                state.pending != null -> "Waiting for the last message"
                state.chat.marathon.enabled -> "Describe a long task to plan and complete…"
                else -> "Ask or tell me what to do…"
            }
            BasicTextField(
                value = state.composer,
                onValueChange = actions.onComposer,
                modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp, max = 132.dp).focusRequester(composerFocus),
                textStyle = AgentType.Input.copy(color = AgentText),
                cursorBrush = SolidColor(AgentYellow),
                maxLines = 6,
                decorationBox = { innerTextField ->
                    Box {
                        val hintAlpha by animateFloatAsState(if (state.composer.isEmpty()) 1f else 0f, Motion.fast(), label = "composer-hint")
                        if (hintAlpha > 0f) SmoothText(hint, AgentType.Input, AgentFaint, modifier = Modifier.alpha(hintAlpha))
                        innerTextField()
                    }
                },
            )
            // `.composer-controls`: a 36px row. The attach button takes the panel's mic slot
            // (32px, pulled 6px toward the edge), then the 16px context ring and the model name.
            Row(Modifier.heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).offset(x = (-6).dp), verticalAlignment = Alignment.CenterVertically) {
                    AgentIconButton(
                        AppIcons.Attachment,
                        if (state.attachments.isEmpty()) "Add images" else "Add images, ${state.attachments.size} of 4 attached",
                        actions.onPickImages,
                        enabled = state.attachments.size < 4 && state.pending == null,
                        size = 32.dp,
                        tint = AgentQuietIcon,
                    )
                    if (contextWindow != null) {
                        val ratio by animateFloatAsState(contextTokens.toFloat() / contextWindow.toFloat(), Motion.slow(), label = "context-ring")
                        Box(
                            Modifier.size(28.dp).clip(CircleShape).clickable(role = androidx.compose.ui.semantics.Role.Button) { showContext = true }.semantics {
                                contentDescription = "Context usage: ${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens, ${contextPercent(contextTokens, contextWindow)} percent"
                            },
                            contentAlignment = Alignment.Center,
                        ) {
                            Canvas(Modifier.size(14.dp)) {
                                // A 2px stroke centered on a 14px circle fills the panel's 16px ring.
                                val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
                                drawCircle(AgentYellow.copy(alpha = 0.18f), radius = size.minDimension / 2, style = stroke)
                                drawArc(
                                    color = AgentYellow,
                                    startAngle = -90f,
                                    sweepAngle = 360f * ratio.coerceIn(0f, 1f),
                                    useCenter = false,
                                    style = stroke,
                                )
                            }
                        }
                    }
                    Text(
                        state.chat.health.model?.substringAfterLast('/') ?: "Model unavailable",
                        style = AgentType.Small,
                        color = AgentAnswer,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 8.dp).weight(1f),
                    )
                }
                // `.send`: 36px, yellow with a dark arrow; #2a2a2a with a grey arrow when it cannot send.
                val steerBackground by animateColorAsState(if (state.canSteer) AgentYellow else AgentControl, Motion.base(), label = "steer-background")
                val steerTint by animateColorAsState(if (state.canSteer) AgentBackground else AgentStepMeta, Motion.base(), label = "steer-tint")
                AnimatedVisibility(
                    visible = state.busy && state.composer.isNotBlank() && resolveSlashCommand(state.composer) == null,
                    enter = fadeIn(Motion.base()) + expandHorizontally(Motion.base()),
                    exit = fadeOut(Motion.fast()) + shrinkHorizontally(Motion.base()),
                ) {
                    AgentIconButton(
                        AppIcons.ArrowUp,
                        "Steer: stop the current turn and send this message",
                        actions.onSend,
                        modifier = Modifier.padding(end = 6.dp).background(steerBackground, CircleShape),
                        enabled = state.canSteer,
                        size = 36.dp,
                        iconSize = 18.dp,
                        tint = steerTint,
                    )
                }
                Crossfade(targetState = state.busy, animationSpec = Motion.fast(), label = "send-or-stop") { busy ->
                    if (busy) {
                        // `.stop`: a 12px red square on a #262626 disc.
                        Box(
                            Modifier
                                .size(36.dp)
                                .clip(CircleShape)
                                .background(AgentPanelHover)
                                .clickable(enabled = state.canStop, role = androidx.compose.ui.semantics.Role.Button, onClick = actions.onStop)
                                .semantics {
                                    contentDescription = if (state.chat.turn.status == "stopping" || state.stopInFlight) "Stopping current turn" else "Stop current turn"
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(Modifier.size(12.dp).background(AgentDanger, RoundedCornerShape(3.dp)))
                        }
                    } else {
                        val exactCommand = resolveSlashCommand(state.composer)
                        val sendEnabled = if (exactCommand == null) state.canSend else when (exactCommand.id) {
                            "new" -> state.canStartNew
                            "model" -> !state.busy
                            "marathon" -> state.canToggleMarathon
                            else -> false
                        }
                        val sendBackground by animateColorAsState(if (sendEnabled) AgentYellow else AgentControl, Motion.base(), label = "send-background")
                        val sendTint by animateColorAsState(if (sendEnabled) AgentBackground else AgentStepMeta, Motion.base(), label = "send-tint")
                        AgentIconButton(
                            AppIcons.ArrowUp,
                            "Send",
                            { if (exactCommand == null) actions.onSend() else onSlashCommand(exactCommand.id) },
                            modifier = Modifier.background(sendBackground, CircleShape),
                            enabled = sendEnabled,
                            size = 36.dp,
                            iconSize = 18.dp,
                            tint = sendTint,
                        )
                    }
                }
            }
        }
    }
    if (showContext && contextWindow != null) {
        AgentAlert(
            title = "Context usage",
            text = "${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} tokens\n" +
                "${contextPercent(contextTokens, contextWindow)}% of the selected model's context is used.",
            confirm = "OK",
            dismiss = null,
            onConfirm = { showContext = false },
            onDismiss = { showContext = false },
        )
    }
}

private fun formatTokens(tokens: Long): String = "%,d".format(tokens)

private fun contextPercent(used: Long, window: Long): String {
    val percent = used.toDouble() * 100 / window.toDouble()
    return if (percent > 0 && percent < 0.1) "<0.1" else "%.1f".format(percent)
}

@Composable
private fun Attachment(image: PromptImage, index: Int, onRemove: (Int) -> Unit) {
    val bitmap = remember(image) {
        val options = BitmapFactory.Options().apply { inSampleSize = 8 }
        BitmapFactory.decodeByteArray(image.bytes, 0, image.bytes.size, options)?.asImageBitmap()
    }
    // `.image-chips > *`
    val shape = RoundedCornerShape(10.dp)
    Row(
        Modifier.heightIn(min = 42.dp).background(Color(0xFF222222), shape).border(1.dp, AgentChipBorder, shape).padding(horizontal = 6.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        if (bitmap != null) {
            Image(
                bitmap,
                contentDescription = "Attached image ${index + 1}",
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(32.dp).clip(RoundedCornerShape(6.dp)),
            )
        } else {
            Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { Text("IMG", style = AgentType.Tiny, color = AgentMuted) }
        }
        Text(image.name, style = AgentType.Meta, color = Color(0xFFCFCFCF), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 100.dp))
        AgentIconButton(AppIcons.Close, "Remove image ${index + 1}", { onRemove(index) }, size = 22.dp, iconSize = 13.dp, tint = AgentMuted)
    }
}

@Composable
private fun UtilityDialog(
    panel: UtilityPanel,
    state: UiState,
    onDismiss: () -> Unit,
    onReconnect: () -> Unit,
    onOpenHistory: (String) -> Unit,
    onEditPairing: () -> Unit,
    onForget: () -> Unit,
    onEnableNotifications: () -> Unit,
    onSendTestPush: () -> Unit,
) {
    Surface(Modifier.fillMaxSize(), color = AgentBackground) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            // `.modal-head`
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 18.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    when (panel) {
                        UtilityPanel.SETTINGS -> "Settings"
                        UtilityPanel.DIAGNOSTICS -> "Diagnostics"
                        UtilityPanel.HISTORY -> "History"
                    },
                    style = AgentType.Title,
                    color = AgentText,
                    modifier = Modifier.weight(1f),
                )
                AgentCloseButton("Close", onDismiss)
            }
            if (panel == UtilityPanel.HISTORY) {
                HistoryPanel(state.chat.sessions, onOpenHistory, Modifier.weight(1f))
            } else {
                // `.modal-body`
                Column(
                    Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(26.dp),
                ) {
                    if (panel == UtilityPanel.SETTINGS) {
                        SettingsContent(state, onEditPairing, onForget, onEnableNotifications, onSendTestPush)
                    } else {
                        DiagnosticsContent(state, onReconnect)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsContent(state: UiState, onEditPairing: () -> Unit, onForget: () -> Unit, onEnableNotifications: () -> Unit, onSendTestPush: () -> Unit) {
    Section("Model") {
        InfoCard {
            KeyValue("Current model", state.chat.health.model?.substringAfterLast('/') ?: "Unavailable")
            Text(
                "Choose the model and reasoning effort in the desktop side panel. The phone remote API is read-only for model settings.",
                style = AgentType.Hint,
                color = AgentHint,
            )
        }
    }
    Section("Notifications") {
        val status = state.push.status
        InfoCard {
            HealthRow(
                "Push to this phone",
                state.push.label,
                when (status) {
                    PushState.Status.REGISTERED -> Level.OK
                    PushState.Status.REGISTERING -> Level.UNKNOWN
                    PushState.Status.FAILED -> Level.BAD
                    else -> Level.WARN
                },
            )
            state.push.detail?.let { Text(it, style = AgentType.Hint, color = AgentHint) }
        }
        if (status == PushState.Status.NEEDS_PERMISSION) {
            AgentButton("Allow notifications", onEnableNotifications, wide = true)
        }
        // V7: the one-tap delivery check. The route's answer appears in the
        // notice banner — including an explicit "no Firebase key" / "no
        // registered phones" — so the button works in every push state.
        AgentButton(
            "Send test notification",
            onSendTestPush,
            wide = true,
            enabled = state.link.status == LinkStatus.LIVE && state.chat.synced && !state.testPushInFlight,
            loading = state.testPushInFlight,
        )
        Text(
            "A notification only says that the agent needs you, may be stuck, finished, or failed. It never contains your prompt, the answer, or a screenshot. \"On\" means the computer has this phone's address, not that a notification is guaranteed to arrive.",
            style = AgentType.Hint,
            color = AgentHint,
        )
    }
    Section("Connection") {
        InfoCard { KeyValue("Server", state.host) }
        AgentButton("Update pairing and token", onEditPairing, primary = true, wide = true)
        AgentButton("Forget pairing", onForget, danger = true, wide = true)
        Text(
            "The token is encrypted on this phone and is never shown here. Forgetting it does not rotate the token on the computer.",
            style = AgentType.Hint,
            color = AgentHint,
        )
    }
}

@Composable
private fun DiagnosticsContent(state: UiState, onReconnect: () -> Unit) {
    val health = state.chat.health
    val live = state.link.status == LinkStatus.LIVE && state.chat.synced
    Section("Connection") {
        InfoCard {
            HealthRow("Companion", connectionLabel(state.link.status), if (state.link.status == LinkStatus.LIVE) Level.OK else if (state.link.status == LinkStatus.AUTH_FAILED || state.link.status == LinkStatus.HOST_REJECTED) Level.BAD else Level.WARN)
            HealthRow("Model runtime", runtimeLabel(health, live), runtimeLevel(health, live))
            HealthRow("Browser", when {
                !live || health.uiConnected == null -> "Unknown"
                !health.uiConnected -> "Not connected"
                health.executorHost == "background" -> "Connected, side panel closed"
                else -> "Connected, side panel open"
            }, when {
                !live || health.uiConnected == null -> Level.UNKNOWN
                health.uiConnected -> Level.OK
                else -> Level.BAD
            })
            HealthRow("Browser tools", when {
                !live || health.toolsConnected == null -> "Unknown"
                health.toolsConnected -> "Ready"
                !state.busy && health.dsh == "ready" -> "Starts with the next turn"
                else -> "Offline"
            }, when {
                !live || health.toolsConnected == null -> Level.UNKNOWN
                health.toolsConnected -> Level.OK
                !state.busy && health.dsh == "ready" -> Level.WARN
                else -> Level.BAD
            })
        }
        state.link.detail?.let { Text(it, style = AgentType.Hint, color = AgentHint) }
        AgentButton("Reconnect now", onReconnect, wide = true) {
            Icon(AppIcons.Refresh, contentDescription = null, tint = AgentTextSoft, modifier = Modifier.size(14.dp))
        }
    }
    Section("Session") {
        InfoCard {
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    KeyValue("Server", state.host)
                    KeyValue("Session", state.chat.sessionId ?: "Waiting for companion")
                    KeyValue("Companion instance", state.chat.instanceId ?: "Unknown")
                    KeyValue("Latest sequence", state.chat.lastSeq.toString())
                    KeyValue("Unreadable frames", state.chat.malformedFrames.toString())
                }
            }
        }
        Text(
            "Diagnostics contain connection state only. Pairing tokens and authorization headers are never displayed.",
            style = AgentType.Hint,
            color = AgentHint,
        )
    }
}

private fun connectionLabel(status: LinkStatus): String = when (status) {
    LinkStatus.LIVE -> "Connected"
    LinkStatus.CONNECTING -> "Connecting"
    LinkStatus.RECONNECTING -> "Reconnecting"
    LinkStatus.PAUSED -> "Paused while app is closed"
    LinkStatus.AUTH_FAILED -> "Token rejected"
    LinkStatus.HOST_REJECTED -> "Address rejected"
}

private fun runtimeLabel(health: Health, live: Boolean): String = when {
    !live -> "Unknown"
    health.dsh == "ready" -> health.model?.substringAfterLast('/') ?: "Ready"
    health.dsh == "starting" || health.dsh == null -> "Starting"
    else -> health.dshMessage ?: health.dsh
}

private fun runtimeLevel(health: Health, live: Boolean): Level = when {
    !live -> Level.UNKNOWN
    health.dsh == "ready" -> Level.OK
    health.dsh == "starting" || health.dsh == null -> Level.WARN
    else -> Level.BAD
}

/** `.settings-section`: a quiet 13px heading over its content. */
@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = AgentType.Section, color = AgentHint)
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { content() }
    }
}

/** `.log-stats`: a bordered panel of small values. */
@Composable
private fun InfoCard(content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(13.dp)
    Column(
        Modifier.fillMaxWidth().background(AgentPanel, shape).border(1.dp, AgentBorder, shape).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) { content() }
}

private val StatValue = agentType(12f, 1.65f)

@Composable
private fun KeyValue(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, style = AgentType.Tiny, color = AgentSubtle)
        Text(value, style = StatValue, color = AgentStat)
    }
}

/** `.log-signal`: a 6px state dot before a 12px line. */
@Composable
private fun HealthRow(label: String, value: String, level: Level) {
    val color = when (level) {
        Level.OK -> AgentGreen
        Level.WARN -> AgentYellow
        Level.BAD -> AgentDanger
        Level.UNKNOWN -> AgentDim
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(label, style = AgentType.Note, color = AgentLabel, modifier = Modifier.weight(1f))
        Text(value, style = AgentType.Note, color = AgentStat, maxLines = 2, textAlign = TextAlign.End)
    }
}
