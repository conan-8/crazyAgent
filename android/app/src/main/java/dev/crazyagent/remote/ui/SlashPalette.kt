package dev.crazyagent.remote.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun SlashPalette(
    commands: List<SlashCommand>,
    enabledFor: (SlashCommand) -> Boolean,
    onSelect: (SlashCommand) -> Unit,
) {
    if (commands.isEmpty()) return
    var selected by remember(commands) { mutableIntStateOf(0) }
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = AgentPanelRaised,
        border = BorderStroke(1.dp, AgentBorder),
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 6.dp),
    ) {
        Column(Modifier.padding(6.dp)) {
            commands.forEachIndexed { index, command ->
                val enabled = enabledFor(command)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (index == selected) AgentYellow.copy(alpha = 0.10f) else Color.Transparent)
                        .clickable(enabled = enabled) {
                            selected = index
                            onSelect(command)
                        }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    Text(command.usage, color = if (enabled) AgentYellow else AgentFaint, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    Text(
                        command.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (enabled) AgentMuted else AgentFaint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 12.dp).weight(1f),
                    )
                }
            }
            Text(
                "Tap a command · other slash-leading text is sent normally",
                style = MaterialTheme.typography.labelSmall,
                color = AgentFaint,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
fun PlanModeChip(onCancel: () -> Unit) {
    Surface(shape = RoundedCornerShape(50), color = AgentYellow.copy(alpha = 0.10f)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 9.dp)) {
            Text("Plan mode · next turn", style = MaterialTheme.typography.labelSmall, color = AgentYellow)
            IconButton(onClick = onCancel, modifier = Modifier.size(25.dp)) {
                Icon(AppIcons.Close, contentDescription = "Cancel plan mode", tint = AgentYellow, modifier = Modifier.size(13.dp))
            }
        }
    }
}
