package dev.crazyagent.remote.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

internal val AgentBackground = Color(0xFF121212)
internal val AgentPanel = Color(0xFF1A1A1A)
internal val AgentPanelRaised = Color(0xFF1F1F1F)
internal val AgentPanelHover = Color(0xFF262626)
internal val AgentBorder = Color(0xFF262626)
internal val AgentText = Color(0xFFECECEC)
internal val AgentTextSoft = Color(0xFFD0D0D0)
internal val AgentMuted = Color(0xFF858585)
internal val AgentFaint = Color(0xFF5F5F5F)
internal val AgentYellow = Color(0xFFFFC300)
internal val AgentDanger = Color(0xFFF85149)
internal val AgentGreen = Color(0xFF3EB44E)

private val SidebarColors = darkColorScheme(
    primary = AgentYellow,
    onPrimary = AgentBackground,
    secondary = AgentTextSoft,
    onSecondary = AgentBackground,
    background = AgentBackground,
    onBackground = AgentText,
    surface = AgentBackground,
    onSurface = AgentText,
    surfaceVariant = AgentPanelRaised,
    onSurfaceVariant = AgentMuted,
    outline = AgentBorder,
    outlineVariant = AgentBorder,
    error = AgentDanger,
    onError = AgentBackground,
    secondaryContainer = Color(0xFF241919),
    onSecondaryContainer = AgentTextSoft,
    tertiaryContainer = Color(0xFF282211),
    onTertiaryContainer = AgentTextSoft,
)

@Composable
fun RemoteTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = SidebarColors, content = content)
}
