package dev.crazyagent.remote.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.crazyagent.remote.app.ArchivedChat
import dev.crazyagent.remote.state.SessionSummary
import dev.crazyagent.remote.state.displayRows
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun RecentSessions(
    sessions: List<SessionSummary>,
    onOpen: (String) -> Unit,
    onViewAll: () -> Unit,
) {
    if (sessions.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Recent sessions", style = MaterialTheme.typography.labelLarge, color = AgentMuted, modifier = Modifier.weight(1f))
            TextButton(onClick = onViewAll) { Text("View all", color = AgentYellow) }
        }
        for (session in sessions.take(3)) {
            SessionCard(session, onOpen)
        }
    }
}

@Composable
fun HistoryPanel(sessions: List<SessionSummary>, onOpen: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val matches = sessions.filter { it.title.contains(query.trim(), ignoreCase = true) }
    OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        placeholder = { Text("Search chats…") },
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    )
    if (matches.isEmpty()) {
        Text(
            if (sessions.isEmpty()) "No saved chats yet" else "No chats match this search",
            style = MaterialTheme.typography.bodyMedium,
            color = AgentFaint,
            modifier = Modifier.padding(vertical = 24.dp),
        )
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            for (session in matches) SessionCard(session, onOpen)
        }
    }
}

@Composable
private fun SessionCard(session: SessionSummary, onOpen: (String) -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (session.running) AgentPanelRaised else AgentPanel,
        border = BorderStroke(1.dp, if (session.running) AgentYellow.copy(alpha = 0.35f) else AgentBorder),
        modifier = Modifier.fillMaxWidth().clickable { onOpen(session.sessionId) },
    ) {
        Row(Modifier.padding(horizontal = 13.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(session.title, style = MaterialTheme.typography.bodyMedium, color = AgentTextSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    historyDate(session.updatedAt) + if (session.truncated) " · Older messages trimmed" else "",
                    style = MaterialTheme.typography.labelSmall,
                    color = AgentFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (session.running) {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = AgentYellow)
                Text("Running", style = MaterialTheme.typography.labelSmall, color = AgentYellow, modifier = Modifier.padding(start = 6.dp))
            } else if (session.current) {
                Text("Current", style = MaterialTheme.typography.labelSmall, color = AgentYellow, modifier = Modifier.padding(start = 8.dp))
            }
        }
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
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = AgentBackground) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 12.dp, bottom = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f).padding(end = 12.dp)) {
                        Text(chat.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            "Saved transcript${if (chat.updatedAt.isNotEmpty()) " · ${historyDate(chat.updatedAt)}" else ""}",
                            style = MaterialTheme.typography.labelMedium,
                            color = AgentFaint,
                        )
                    }
                    Surface(shape = CircleShape, color = AgentPanelRaised, border = BorderStroke(1.dp, AgentBorder)) {
                        IconButton(onClick = onDismiss, modifier = Modifier.size(38.dp)) {
                            Icon(AppIcons.Close, contentDescription = "Close saved chat", modifier = Modifier.size(17.dp))
                        }
                    }
                }
                if (rows.isEmpty()) {
                    Text("This saved chat has no messages.", color = AgentMuted, modifier = Modifier.padding(20.dp))
                } else {
                    LazyColumn(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        items(rows, key = { it.key }) { row -> RowView(row) }
                    }
                }
                if (rows.isEmpty()) Spacer(Modifier.weight(1f))
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Button(
                        onClick = if (isCurrent) onDismiss else onContinue,
                        enabled = isCurrent || (canContinue && !continuing),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = AgentYellow, contentColor = AgentBackground),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (continuing) {
                            CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp, color = AgentBackground)
                        } else {
                            Text(if (isCurrent) "This is the current chat · Back to it" else "Continue this chat")
                        }
                    }
                    Text(
                        when {
                            isCurrent -> "Your next message continues this conversation."
                            busy -> "Wait for the running turn to finish, or stop it, before switching chats."
                            else -> "Switches the agent, and the desktop side panel's next turn, to this conversation. Very old chats may no longer be continuable."
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = AgentFaint,
                    )
                }
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
