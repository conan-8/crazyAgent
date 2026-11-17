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

/**
 * `.marathon-mode`: the chip above the composer while the companion-owned
 * marathon switch is on (M5). It stays visible and tappable while a turn runs;
 * tapping it (or the ×) asks the companion to toggle the shared switch — the
 * chip itself only changes when the authoritative `remote.marathon` arrives.
 * [alert] ambers it while a watch alert is open, like the panel.
 */
@Composable
fun MarathonChip(copy: String, alert: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 18.dp, end = 18.dp, bottom = 8.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, role = androidx.compose.ui.semantics.Role.Button, onClick = onToggle)
            .padding(horizontal = 2.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // `.marathon-mode.alert .marathon-mode-badge`: solid yellow while an alert is open.
        val badgeShape = RoundedCornerShape(50)
        Text(
            "MARATHON",
            style = AgentType.Badge,
            color = if (alert) Color(0xFF1A1A1A) else AgentYellow,
            maxLines = 1,
            modifier = Modifier
                .background(if (alert) AgentYellow else AgentYellowSoft, badgeShape)
                .border(1.dp, AgentYellow.copy(alpha = if (alert) 0.85f else 0.35f), badgeShape)
                .padding(horizontal = 7.dp, vertical = 2.dp),
        )
        Text(
            copy,
            style = if (alert) AgentType.Tiny.copy(fontWeight = FontWeight.SemiBold) else AgentType.Tiny,
            color = if (alert) AgentYellow else AgentMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        AgentIconButton(AppIcons.Close, "Turn marathon mode off", onToggle, enabled = enabled, size = 22.dp, iconSize = 12.dp, tint = AgentMuted)
    }
}
