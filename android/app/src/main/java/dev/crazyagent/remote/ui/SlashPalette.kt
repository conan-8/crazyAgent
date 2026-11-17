package dev.crazyagent.remote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun SlashPalette(
    commands: List<SlashCommand>,
    enabledFor: (SlashCommand) -> Boolean,
    onSelect: (SlashCommand) -> Unit,
) {
    if (commands.isEmpty()) return
    var selected by remember(commands) { mutableIntStateOf(0) }
    // `.slash-menu`: the panel's floating surface, sitting on the composer's top edge.
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, bottom = 1.dp)
            .background(AgentMenu, shape)
            .border(1.dp, AgentMenuBorder, shape)
            .padding(6.dp),
    ) {
        commands.forEachIndexed { index, command ->
            val enabled = enabledFor(command)
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (index == selected) AgentYellowSoft else Color.Transparent)
                    .clickable(enabled = enabled) {
                        selected = index
                        onSelect(command)
                    }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
            ) {
                Text(
                    command.usage,
                    style = agentType(12.5f, weight = FontWeight.SemiBold, family = FontFamily.Monospace),
                    color = if (enabled) AgentYellow else AgentFaint,
                    modifier = Modifier.alignByBaseline(),
                )
                Text(
                    command.description,
                    style = AgentType.Meta,
                    color = when {
                        !enabled -> AgentFaint
                        index == selected -> AgentTextSoft
                        else -> Color(0xFF9A9A9A)
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).alignByBaseline(),
                )
            }
        }
        HorizontalDivider(color = AgentBorder, modifier = Modifier.padding(top = 4.dp))
        Text(
            "Tap a command · other slash-leading text is sent normally",
            style = agentType(10.5f, 1.4f),
            color = AgentFaint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 10.dp, end = 10.dp, top = 6.dp, bottom = 2.dp),
        )
    }
}

/** `.plan-mode`: the line above the composer while the next turn is armed for a plan. */
@Composable
fun PlanModeRow(onCancel: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AgentBadge("Plan")
        Text("Next turn uses a live checklist", style = AgentType.Tiny, color = AgentMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        AgentIconButton(AppIcons.Close, "Cancel plan mode", onCancel, size = 22.dp, iconSize = 12.dp, tint = AgentMuted)
    }
}
