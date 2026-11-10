package dev.crazyagent.remote.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.crazyagent.remote.app.LinkStatus
import dev.crazyagent.remote.app.PendingPhase
import dev.crazyagent.remote.app.PendingPrompt
import dev.crazyagent.remote.app.UiState
import dev.crazyagent.remote.data.PromptImage
import dev.crazyagent.remote.notifications.PushState
import dev.crazyagent.remote.state.DisplayRow
import dev.crazyagent.remote.state.Draft
import dev.crazyagent.remote.state.Health
import dev.crazyagent.remote.state.NoteKind
import dev.crazyagent.remote.state.activityLine
import dev.crazyagent.remote.state.displayRows

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
    val onTogglePlanMode: () -> Unit,
    val onCaptureScreen: () -> Unit,
    val onEnableNotifications: () -> Unit,
)

private enum class UtilityPanel { SETTINGS, DIAGNOSTICS, HISTORY }
private enum class Level { OK, WARN, BAD, UNKNOWN }

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

    LaunchedEffect(tail, state.chat.draft?.text?.length) {
        if (tail > 0) listState.scrollToItem(tail - 1)
    }

    LaunchedEffect(empty) {
        if (empty) actions.onRefreshSessions()
    }

    val liveBitmap = rememberLiveBitmap(state.liveImage)
    var viewerOpen by rememberSaveable { mutableStateOf(false) }
    var liveCollapsed by rememberSaveable { mutableStateOf(false) }
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
        state.notice?.let { Banner(it, "Dismiss", actions.onDismissNotice, danger = false) }
        healthIssue(state)?.let { Banner(it, "Details", { panel = UtilityPanel.DIAGNOSTICS }, danger = true) }
        if (state.historyLoading) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = AgentYellow)
                Text("Loading saved chat…", style = MaterialTheme.typography.bodySmall, color = AgentMuted)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (empty) {
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
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    items(rows, key = { it.key }) { row -> RowView(row) }
                    state.chat.draft?.let { draft -> item(key = "draft:${draft.streamId}") { DraftView(draft) } }
                    state.pending?.let { pending -> item(key = "pending:${pending.clientMessageId}") { PendingView(pending, state, actions) } }
                    activity?.let { line ->
                        item(key = "activity") {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.padding(vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                            ) {
                                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = AgentYellow)
                                Text(line, style = MaterialTheme.typography.bodySmall, color = AgentYellow)
                            }
                        }
                    }
                }
            }
        }
        state.chat.help?.takeIf { state.chat.turn.isWaiting }?.let { help ->
            HelpCard(
                help = help,
                // Only offer the view when the capture made for this request is the one on screen.
                canShowScreen = help.screenshotId != null && help.screenshotId == state.liveImage?.id,
                onShowScreen = { viewerOpen = true },
            )
        }
        Composer(
            state = state,
            actions = actions,
            highlight = empty,
            onSlashCommand = { command ->
                actions.onComposer("")
                when (command) {
                    "new" -> if (state.canStartNew) confirmNew = true
                    "model" -> if (!state.busy) panel = UtilityPanel.SETTINGS
                    "plan" -> if (!state.busy && state.pending == null) actions.onTogglePlanMode()
                }
            },
        )
        Text(
            "Shared with the desktop side panel",
            style = MaterialTheme.typography.labelSmall,
            fontSize = 9.sp,
            color = AgentFaint,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 3.dp),
            textAlign = TextAlign.Center,
        )
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(AgentBackground).safeDrawingPadding()) {
        val bitmap = liveBitmap
        val beside = bitmap != null && !liveCollapsed && LiveViewMath.sideBySide(maxWidth.value, maxHeight.value)
        val paneHeight = bitmap?.let { LiveViewMath.paneHeightDp(maxWidth.value, maxHeight.value, it.width.toFloat() / it.height) }
        // Below the top icons: the open pane, or a slim bar to reopen it. The
        // slot keeps its place in the column, so the composer keeps focus.
        val liveSlot: @Composable () -> Unit = {
            if (bitmap != null) {
                if (liveCollapsed) {
                    LiveCollapsedBar(state.liveImageLoading) { liveCollapsed = false }
                } else if (!beside && paneHeight != null) {
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
            } else if (state.link.status == LinkStatus.LIVE && state.chat.synced && state.liveImage == null && !state.liveImageLoading) {
                // Nothing on screen: say why, and offer a fresh capture.
                LiveEmptyBar(
                    message = if (state.liveImageUnavailable) "The last screenshot is no longer available" else "No live view yet",
                    canCapture = state.canCapture,
                    capturing = state.snapshotInFlight,
                    onCapture = actions.onCaptureScreen,
                )
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

    liveBitmap?.let { bitmap ->
        if (viewerOpen) LiveViewer(bitmap, state.liveImageLoading) { viewerOpen = false }
    }

    panel?.let { current ->
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
        )
    }
    state.historyOpen?.let { archived ->
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
        AlertDialog(
            onDismissRequest = { confirmNew = false },
            containerColor = AgentPanelRaised,
            title = { Text("Start a new chat?") },
            text = { Text("This starts a new session for the desktop side panel too.") },
            confirmButton = { TextButton(onClick = { confirmNew = false; actions.onNewChat() }) { Text("New chat") } },
            dismissButton = { TextButton(onClick = { confirmNew = false }) { Text("Cancel") } },
        )
    }
    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            containerColor = AgentPanelRaised,
            title = { Text("Forget this pairing?") },
            text = { Text("The token is deleted from this phone. To also lock out a lost phone, rotate the token on the computer with --new-remote-token.") },
            confirmButton = { TextButton(onClick = { confirmForget = false; actions.onForget() }) { Text("Forget", color = AgentDanger) } },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Header(state: UiState, onNew: () -> Unit, onHistory: () -> Unit, onDiagnostics: () -> Unit, onSettings: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, top = 8.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.Cursor, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(23.dp))
        Text(
            "crazyAgent",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 9.dp).weight(1f),
        )
        Surface(shape = CircleShape, color = AgentPanelRaised, border = BorderStroke(1.dp, AgentBorder)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onNew, enabled = state.canStartNew, modifier = Modifier.size(38.dp)) {
                    if (state.newInFlight) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(AppIcons.Plus, contentDescription = "New chat", modifier = Modifier.size(19.dp))
                    }
                }
                IconButton(onClick = onHistory, modifier = Modifier.size(38.dp)) {
                    Icon(AppIcons.History, contentDescription = "Chat history", modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = onDiagnostics, modifier = Modifier.size(38.dp)) {
                    Icon(AppIcons.Diagnostics, contentDescription = "Connection diagnostics", modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = onSettings, modifier = Modifier.size(38.dp)) {
                    Icon(AppIcons.Settings, contentDescription = "Settings", modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

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
    val color = when {
        state.busy -> AgentYellow
        state.link.status == LinkStatus.LIVE && state.chat.synced && state.chat.turn.isWaiting -> AgentYellow
        state.link.status == LinkStatus.LIVE && state.chat.synced -> AgentGreen
        state.link.status == LinkStatus.AUTH_FAILED || state.link.status == LinkStatus.HOST_REJECTED -> AgentDanger
        else -> AgentFaint
    }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(label, style = MaterialTheme.typography.labelMedium, color = AgentMuted, maxLines = 1)
        Text(
            state.host,
            style = MaterialTheme.typography.labelSmall,
            color = AgentFaint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun EmptyState(state: UiState, onOpenHistory: (String) -> Unit, onViewAll: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (!state.chat.synced) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(color = AgentYellow, modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                Text("Connecting to your companion…", style = MaterialTheme.typography.bodySmall, color = AgentMuted)
            }
        } else {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            ) {
                RecentSessions(state.chat.sessions, onOpenHistory, onViewAll)
            }
        }
    }
}

/**
 * The agent's own structured request for the user. It offers no Approve/Deny:
 * the only way forward is an ordinary reply, which continues this chat.
 */
@Composable
private fun HelpCard(help: dev.crazyagent.remote.state.HelpRequest, canShowScreen: Boolean, onShowScreen: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = Color(0xFF242112),
        border = BorderStroke(1.dp, AgentYellow.copy(alpha = 0.45f)),
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
    ) {
        Column(
            Modifier.padding(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(dev.crazyagent.remote.state.helpTitle(help.category), style = MaterialTheme.typography.labelLarge, color = AgentYellow, fontWeight = FontWeight.SemiBold)
            SelectionContainer {
                Text(help.reason, style = MaterialTheme.typography.bodySmall, color = AgentTextSoft, modifier = Modifier.heightIn(max = 120.dp).verticalScroll(rememberScrollState()))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        help.screenshotId == null -> "No screenshot was captured. Reply below to continue."
                        canShowScreen -> "Reply below to continue."
                        else -> "Its screenshot is no longer shown. Reply below to continue."
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = AgentMuted,
                    modifier = Modifier.weight(1f),
                )
                if (canShowScreen) TextButton(onClick = onShowScreen) { Text("Show screen", color = AgentYellow, maxLines = 1) }
            }
        }
    }
}

@Composable
private fun LinkBanner(state: UiState, actions: ChatActions) {
    val link = state.link
    val (message, action) = when (link.status) {
        LinkStatus.AUTH_FAILED -> (link.detail ?: "The token was rejected.") to ("Pair again" to actions.onEditPairing)
        LinkStatus.HOST_REJECTED -> (link.detail ?: "The server refused this address.") to ("Retry" to actions.onReconnect)
        LinkStatus.RECONNECTING -> (link.detail ?: "Reconnecting…") to ("Retry now" to actions.onReconnect)
        else -> return
    }
    Banner(message, action.first, action.second, danger = true)
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

@Composable
private fun Banner(message: String, actionLabel: String, onAction: () -> Unit, danger: Boolean) {
    val accent = if (danger) AgentDanger else AgentYellow
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (danger) Color(0xFF241919) else Color(0xFF242112),
        border = BorderStroke(1.dp, accent.copy(alpha = 0.28f)),
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
    ) {
        Row(Modifier.padding(start = 12.dp, end = 6.dp, top = 5.dp, bottom = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = AgentTextSoft,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
            )
            TextButton(onClick = onAction) { Text(actionLabel, color = AgentYellow, maxLines = 1) }
        }
    }
}

@Composable
internal fun RowView(row: DisplayRow) {
    when (row) {
        is DisplayRow.User -> UserBubble(label = row.from) {
            if (row.text.isNotEmpty()) SelectionContainer { Text(row.text, style = MaterialTheme.typography.bodyMedium, lineHeight = 21.sp) }
            if (row.imageCount > 0) Text(if (row.imageCount == 1) "1 image" else "${row.imageCount} images", style = MaterialTheme.typography.labelSmall, color = AgentMuted)
        }
        is DisplayRow.Assistant -> SelectionContainer(Modifier.padding(vertical = 8.dp)) {
            MarkdownContent(row.text)
        }
        is DisplayRow.Tool -> ToolView(row)
        is DisplayRow.Note -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            modifier = Modifier.padding(vertical = 8.dp),
        ) {
            val color = when (row.kind) {
                NoteKind.ERROR -> AgentDanger
                NoteKind.DONE -> AgentGreen
                NoteKind.STOPPED -> AgentMuted
            }
            Box(Modifier.size(5.dp).background(color, CircleShape))
            Text(
                row.text,
                style = MaterialTheme.typography.labelMedium,
                color = if (row.kind == NoteKind.ERROR) AgentDanger else AgentMuted,
                fontWeight = if (row.kind == NoteKind.ERROR) FontWeight.SemiBold else FontWeight.Normal,
            )
        }
    }
}

@Composable
private fun UserBubble(label: String, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(start = 44.dp, top = 6.dp, bottom = 12.dp), contentAlignment = Alignment.CenterEnd) {
        Surface(shape = RoundedCornerShape(16.dp), color = AgentPanelRaised, border = BorderStroke(1.dp, AgentBorder)) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(label, style = MaterialTheme.typography.labelSmall, fontSize = 10.sp, color = AgentMuted)
                content()
            }
        }
    }
}

@Composable
private fun ToolView(row: DisplayRow.Tool) {
    var open by remember { mutableStateOf(false) }
    val status = when (row.result?.ok) {
        true -> "Done"
        false -> "Failed"
        null -> "Running"
    }
    val statusColor = when (row.result?.ok) {
        true -> AgentFaint
        false -> AgentDanger
        null -> AgentYellow
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { open = !open }
                .semantics { contentDescription = "Tool ${row.name}, $status. Tap for details." }
                .padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(AppIcons.Tool, contentDescription = null, tint = if (row.result?.ok == false) AgentDanger else AgentMuted, modifier = Modifier.size(17.dp))
            Text(toolTitle(row.name), style = MaterialTheme.typography.bodyMedium, color = AgentTextSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(status, style = MaterialTheme.typography.labelSmall, color = statusColor)
            Icon(AppIcons.Chevron, contentDescription = if (open) "Collapse" else "Expand", tint = AgentFaint, modifier = Modifier.size(14.dp).rotate(if (open) 0f else -90f))
        }
        if (open) {
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = AgentPanel,
                border = BorderStroke(1.dp, AgentBorder),
                modifier = Modifier.fillMaxWidth().padding(start = 25.dp, bottom = 7.dp),
            ) {
                Column(Modifier.padding(11.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (row.args.isNotBlank()) Text(row.args.take(2_000), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = AgentMuted)
                    row.result?.text?.takeIf { it.isNotBlank() }?.let { Text(it.take(4_000), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = AgentTextSoft) }
                }
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
    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(if (draft.text.isEmpty()) "Thinking…" else "Responding", style = MaterialTheme.typography.labelMedium, color = AgentYellow)
        if (draft.text.isNotEmpty()) {
            SelectionContainer { MarkdownContent(draft.text) }
        } else if (draft.reasoning.isNotEmpty()) {
            Text(draft.reasoning.takeLast(400), style = MaterialTheme.typography.bodySmall, color = AgentMuted)
        }
        for (tool in draft.tools) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(AppIcons.Tool, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(16.dp))
                Text("${toolTitle(tool.name ?: "tool")}…", style = MaterialTheme.typography.bodySmall, color = AgentMuted)
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
        Text(pending.text, style = MaterialTheme.typography.bodyMedium)
        if (pending.imageCount > 0) Text("${pending.imageCount} image(s)", style = MaterialTheme.typography.labelSmall, color = AgentMuted)
        pending.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AgentYellow, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        if (pending.phase == PendingPhase.NEEDS_REVIEW) {
            val sameInstance = pending.instanceId == state.chat.instanceId && pending.images.size == pending.imageCount
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                if (sameInstance) TextButton(onClick = actions.onRetryPending) { Text("Retry") }
                TextButton(onClick = actions.onResendPending, enabled = state.link.status == LinkStatus.LIVE && !state.busy) { Text("Send again") }
                TextButton(onClick = actions.onEditPending) { Text("Edit") }
                TextButton(onClick = actions.onDiscardPending) { Text("Discard") }
            }
        }
    }
}

@Composable
private fun Composer(state: UiState, actions: ChatActions, highlight: Boolean, onSlashCommand: (String) -> Unit) {
    var showContext by rememberSaveable { mutableStateOf(false) }
    val contextWindow = state.chat.health.contextWindow?.takeIf { it > 0 }
    val contextTokens = (state.chat.health.contextTokens ?: 0).coerceAtLeast(0)
    val slashMatches = slashQuery(state.composer)?.let(::matchSlashCommands).orEmpty()
    SlashPalette(
        commands = slashMatches,
        enabledFor = { command ->
            when (command.id) {
                "new" -> state.canStartNew
                "model" -> !state.busy
                "plan" -> !state.busy && state.pending == null
                else -> false
            }
        },
        onSelect = { command -> onSlashCommand(command.id) },
    )
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = AgentPanel,
        border = BorderStroke(1.dp, if (highlight) AgentYellow else AgentBorder),
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 5.dp),
    ) {
        Column(Modifier.padding(start = 14.dp, end = 10.dp, top = 10.dp, bottom = 9.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            if (state.planMode) PlanModeChip(actions.onTogglePlanMode)
            if (state.attachments.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    state.attachments.forEachIndexed { index, image -> Attachment(image, index, actions.onRemoveImage) }
                }
            }
            val hint = when {
                state.link.status != LinkStatus.LIVE -> "Not connected"
                !state.runtimeReady -> "The model runtime is not ready"
                state.busy -> "Steer the agent: send to redirect this turn…"
                state.pending != null -> "Waiting for the last message"
                state.planMode -> "Describe a long task to plan and complete…"
                else -> "Ask or tell me what to do…"
            }
            BasicTextField(
                value = state.composer,
                onValueChange = actions.onComposer,
                modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp, max = 132.dp),
                textStyle = TextStyle(color = AgentText, fontSize = 14.sp, lineHeight = 21.sp),
                cursorBrush = SolidColor(AgentYellow),
                maxLines = 6,
                decorationBox = { innerTextField ->
                    Box {
                        if (state.composer.isEmpty()) Text(hint, style = MaterialTheme.typography.bodyMedium, color = AgentFaint)
                        innerTextField()
                    }
                },
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(
                    onClick = actions.onPickImages,
                    enabled = state.attachments.size < 4 && state.pending == null,
                    modifier = Modifier.size(36.dp),
                ) {
                    Icon(AppIcons.Attachment, contentDescription = if (state.attachments.isEmpty()) "Add images" else "Add images, ${state.attachments.size} of 4 attached", modifier = Modifier.size(19.dp))
                }
                if (contextWindow != null) {
                    val ratio = contextTokens.toFloat() / contextWindow.toFloat()
                    IconButton(
                        onClick = { showContext = true },
                        modifier = Modifier.size(28.dp).semantics {
                            contentDescription = "Context usage: ${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens, ${contextPercent(contextTokens, contextWindow)} percent"
                        },
                    ) {
                        Canvas(Modifier.size(18.dp)) {
                            val stroke = Stroke(width = 1.5.dp.toPx())
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
                    style = MaterialTheme.typography.bodySmall,
                    color = AgentTextSoft,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 7.dp).weight(1f),
                )
                if (state.busy && state.composer.isNotBlank() && resolveSlashCommand(state.composer) == null) {
                    IconButton(
                        onClick = actions.onSend,
                        enabled = state.canSteer,
                        modifier = Modifier.padding(end = 6.dp).size(40.dp).background(if (state.canSteer) AgentYellow else AgentPanelHover, CircleShape).semantics {
                            contentDescription = "Steer: stop the current turn and send this message"
                        },
                    ) {
                        Icon(AppIcons.ArrowUp, contentDescription = null, tint = if (state.canSteer) AgentBackground else AgentMuted, modifier = Modifier.size(20.dp))
                    }
                }
                if (state.busy) {
                    IconButton(
                        onClick = actions.onStop,
                        enabled = state.canStop,
                        modifier = Modifier.size(40.dp).semantics {
                            contentDescription = if (state.chat.turn.status == "stopping" || state.stopInFlight) "Stopping current turn" else "Stop current turn"
                        },
                    ) {
                        Surface(shape = CircleShape, color = AgentPanelHover, modifier = Modifier.size(38.dp)) {
                            Box(contentAlignment = Alignment.Center) {
                                Box(Modifier.size(12.dp).background(AgentDanger, RoundedCornerShape(3.dp)))
                            }
                        }
                    }
                } else {
                    val exactCommand = resolveSlashCommand(state.composer)
                    val sendEnabled = if (exactCommand == null) state.canSend else when (exactCommand.id) {
                        "new" -> state.canStartNew
                        "model" -> !state.busy
                        "plan" -> !state.busy && state.pending == null
                        else -> false
                    }
                    IconButton(
                        onClick = { if (exactCommand == null) actions.onSend() else onSlashCommand(exactCommand.id) },
                        enabled = sendEnabled,
                        modifier = Modifier.size(40.dp).background(if (sendEnabled) AgentYellow else AgentPanelHover, CircleShape),
                    ) {
                        Icon(AppIcons.ArrowUp, contentDescription = "Send", tint = if (sendEnabled) AgentBackground else AgentMuted, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
    if (showContext && contextWindow != null) {
        AlertDialog(
            onDismissRequest = { showContext = false },
            containerColor = AgentPanelRaised,
            title = { Text("Context usage") },
            text = {
                Text(
                    "${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} tokens\n" +
                        "${contextPercent(contextTokens, contextWindow)}% of the selected model's context is used.",
                )
            },
            confirmButton = { TextButton(onClick = { showContext = false }) { Text("OK") } },
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
    Surface(shape = RoundedCornerShape(10.dp), color = AgentPanelRaised, border = BorderStroke(1.dp, AgentBorder)) {
        Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (bitmap != null) {
                Image(
                    bitmap,
                    contentDescription = "Attached image ${index + 1}",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(36.dp).clip(RoundedCornerShape(6.dp)),
                )
            } else {
                Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { Text("IMG", style = MaterialTheme.typography.labelSmall, color = AgentMuted) }
            }
            Text(image.name, style = MaterialTheme.typography.labelSmall, color = AgentTextSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 100.dp))
            IconButton(onClick = { onRemove(index) }, modifier = Modifier.size(26.dp)) {
                Icon(AppIcons.Close, contentDescription = "Remove image ${index + 1}", modifier = Modifier.size(14.dp))
            }
        }
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
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = AgentBackground) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 12.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        when (panel) {
                            UtilityPanel.SETTINGS -> "Settings"
                            UtilityPanel.DIAGNOSTICS -> "Diagnostics"
                            UtilityPanel.HISTORY -> "History"
                        },
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                    )
                    Surface(shape = CircleShape, color = AgentPanelRaised, border = BorderStroke(1.dp, AgentBorder)) {
                        IconButton(onClick = onDismiss, modifier = Modifier.size(38.dp)) {
                            Icon(AppIcons.Close, contentDescription = "Close", modifier = Modifier.size(17.dp))
                        }
                    }
                }
                Column(
                    Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(22.dp),
                ) {
                    when (panel) {
                        UtilityPanel.SETTINGS -> SettingsContent(state, onEditPairing, onForget, onEnableNotifications)
                        UtilityPanel.DIAGNOSTICS -> DiagnosticsContent(state, onReconnect)
                        UtilityPanel.HISTORY -> HistoryPanel(state.chat.sessions, onOpenHistory)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsContent(state: UiState, onEditPairing: () -> Unit, onForget: () -> Unit, onEnableNotifications: () -> Unit) {
    Section("Model") {
        InfoCard {
            KeyValue("Current model", state.chat.health.model?.substringAfterLast('/') ?: "Unavailable")
            Text(
                "Choose the model and reasoning effort in the desktop side panel. The phone remote API is read-only for model settings.",
                style = MaterialTheme.typography.bodySmall,
                color = AgentMuted,
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
            state.push.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AgentMuted) }
        }
        if (status == PushState.Status.NEEDS_PERMISSION) {
            OutlinedButton(onClick = onEnableNotifications, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) { Text("Allow notifications") }
        }
        Text(
            "A notification only says that the agent needs you, finished, or failed. It never contains your prompt, the answer, or a screenshot. \"On\" means the computer has this phone's address, not that a notification is guaranteed to arrive.",
            style = MaterialTheme.typography.bodySmall,
            color = AgentFaint,
        )
    }
    Section("Connection") {
        InfoCard { KeyValue("Server", state.host) }
        Button(
            onClick = onEditPairing,
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(containerColor = AgentYellow, contentColor = AgentBackground),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Update pairing and token") }
        OutlinedButton(
            onClick = onForget,
            shape = RoundedCornerShape(12.dp),
            border = BorderStroke(1.dp, AgentDanger.copy(alpha = 0.45f)),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = AgentDanger),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Forget pairing") }
        Text(
            "The token is encrypted on this phone and is never shown here. Forgetting it does not rotate the token on the computer.",
            style = MaterialTheme.typography.bodySmall,
            color = AgentFaint,
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
        state.link.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = AgentMuted) }
        OutlinedButton(onClick = onReconnect, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
            Icon(AppIcons.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.size(7.dp))
            Text("Reconnect now")
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
            style = MaterialTheme.typography.bodySmall,
            color = AgentFaint,
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

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = AgentMuted)
        content()
    }
}

@Composable
private fun InfoCard(content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(14.dp), color = AgentPanel, border = BorderStroke(1.dp, AgentBorder), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
    }
}

@Composable
private fun KeyValue(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = AgentFaint)
        Text(value, style = MaterialTheme.typography.bodySmall, color = AgentTextSoft)
    }
}

@Composable
private fun HealthRow(label: String, value: String, level: Level) {
    val color = when (level) {
        Level.OK -> AgentGreen
        Level.WARN -> AgentYellow
        Level.BAD -> AgentDanger
        Level.UNKNOWN -> AgentFaint
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(label, style = MaterialTheme.typography.bodySmall, color = AgentMuted, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = AgentTextSoft, maxLines = 2, textAlign = TextAlign.End)
    }
}
