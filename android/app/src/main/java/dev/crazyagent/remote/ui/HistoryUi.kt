package dev.crazyagent.remote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import dev.crazyagent.remote.app.ArchivedChat
import dev.crazyagent.remote.state.SessionSummary
import dev.crazyagent.remote.state.displayRows
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** `.recent-sessions`: up to three cards, centered on the empty chat. */
@Composable
fun RecentSessions(
    sessions: List<SessionSummary>,
    onOpen: (String) -> Unit,
    onViewAll: () -> Unit,
) {
    if (sessions.isEmpty()) return
    Column(Modifier.widthIn(max = 360.dp).fillMaxWidth()) {
        // The link's own touch padding makes up the head's 8px bottom margin and its end inset.
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Recent sessions", style = AgentType.Meta.copy(letterSpacing = 0.02.em), color = AgentMuted, modifier = Modifier.weight(1f))
            AgentLink("View all", onViewAll)
        }
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            for (session in sessions.take(3)) SessionCard(session, onOpen)
        }
    }
}

/** `.history-search` over `.history-list`: a search field and flat rows. */
@Composable
fun HistoryPanel(sessions: List<SessionSummary>, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    var query by rememberSaveable { mutableStateOf("") }
    val matches = sessions.filter { it.title.contains(query.trim(), ignoreCase = true) }
    Column(modifier.fillMaxWidth()) {
        AgentField(
            value = query,
            onValueChange = { query = it },
            placeholder = "Search chats…",
            leadingIcon = AppIcons.Search,
            textStyle = AgentType.Input,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 10.dp).semantics { contentDescription = "Search chats" },
        )
        if (matches.isEmpty()) {
            Text(
                if (sessions.isEmpty()) "No saved chats yet" else "No chats match this search",
                style = AgentType.Small,
                color = AgentFaint,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 28.dp),
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                items(matches) { session -> HistoryRow(session, onOpen) }
            }
        }
    }
}

@Composable
private fun SessionState(session: SessionSummary) {
    if (session.running) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = AgentYellow, trackColor = AgentYellow.copy(alpha = 0.2f))
            Text("Running", style = AgentType.Tiny, color = AgentYellow)
        }
    } else if (session.current) {
        Text("Current", style = AgentType.Tiny, color = AgentYellow)
    }
}

private fun sessionDate(session: SessionSummary): String =
    historyDate(session.updatedAt) + if (session.truncated) " · Older messages trimmed" else ""

/** `.recent-session-open`. */
@Composable
private fun SessionCard(session: SessionSummary, onOpen: (String) -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 58.dp)
            .clip(shape)
            .background(AgentPanel)
            .border(1.dp, if (session.running) AgentYellow.copy(alpha = 0.28f) else AgentBorder, shape)
            .clickable { onOpen(session.sessionId) }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(session.title, style = AgentType.Small, color = AgentTextSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sessionDate(session), style = AgentType.Tiny, color = AgentFaint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        SessionState(session)
    }
}

/** `.history-item`: a borderless row. */
@Composable
private fun HistoryRow(session: SessionSummary, onOpen: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable { onOpen(session.sessionId) }
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(session.title, style = agentType(14f), color = AgentTextSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(sessionDate(session), style = AgentType.Meta, color = AgentSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        SessionState(session)
    }
}

@Composable
fun ArchivedChatDialog(
    chat: ArchivedChat,
    isCurrent: Boolean,
    canContinue: Boolean,
    continuing: Boolean,
    busy: Boolean,
    onContinue: () -> Unit,
    onDismiss: () -> Unit,
) {
    val rows = remember(chat.items) { displayRows(chat.items) }
    Surface(Modifier.fillMaxSize(), color = AgentBackground) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 18.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(chat.title, style = AgentType.Title, color = AgentText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        "Saved transcript${if (chat.updatedAt.isNotEmpty()) " · ${historyDate(chat.updatedAt)}" else ""}",
                        style = AgentType.Meta,
                        color = AgentSubtle,
                    )
                }
                AgentCloseButton("Close saved chat", onDismiss)
            }
            if (rows.isEmpty()) {
                Text("This saved chat has no messages.", style = AgentType.Small, color = AgentFaint, modifier = Modifier.padding(20.dp))
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    items(rows, key = { it.key }) { row -> RowView(row) }
                }
            }
            if (rows.isEmpty()) Spacer(Modifier.weight(1f))
            Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AgentButton(
                    text = if (isCurrent) "This is the current chat · Back to it" else "Continue this chat",
                    onClick = if (isCurrent) onDismiss else onContinue,
                    primary = true,
                    wide = true,
                    enabled = isCurrent || (canContinue && !continuing),
                    loading = continuing,
                )
                Text(
                    when {
                        isCurrent -> "Your next message continues this conversation."
                        busy -> "Wait for the running turn to finish, or stop it, before switching chats."
                        else -> "Switches the agent, and the desktop side panel's next turn, to this conversation. Very old chats may no longer be continuable."
                    },
                    style = AgentType.Hint,
                    color = AgentHint,
                )
            }
        }
    }
}

fun historyDate(value: String): String = try {
    DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.getDefault())
        .format(Instant.parse(value).atZone(ZoneId.systemDefault()))
} catch (_: Exception) {
    "Saved chat"
}
