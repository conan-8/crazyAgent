package dev.crazyagent.remote.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.crazyagent.remote.R

// The side panel's palette: the `:root` variables of extension/sidepanel/style.css.
internal val AgentBackground = Color(0xFF121212)
internal val AgentPanel = Color(0xFF1A1A1A)
internal val AgentPanelRaised = Color(0xFF1F1F1F)
internal val AgentPanelHover = Color(0xFF262626)
internal val AgentBorder = Color(0xFF262626)
internal val AgentBorderSoft = Color(0xFF1E1E1E)
internal val AgentText = Color(0xFFECECEC)
internal val AgentTextSoft = Color(0xFFD0D0D0)
internal val AgentMuted = Color(0xFF858585)
internal val AgentFaint = Color(0xFF5F5F5F)
internal val AgentYellow = Color(0xFFFFC300)
internal val AgentDanger = Color(0xFFF85149)
internal val AgentGreen = Color(0xFF3EB44E)

/** `--accent-soft`: a 10% yellow wash, and the same wash flattened onto the page. */
internal val AgentYellowSoft = AgentYellow.copy(alpha = 0.10f)
internal val AgentYellowWash = AgentYellowSoft.compositeOver(AgentBackground)

// The greys the side panel uses outside its variables, named by what they color there.
/** `.activity-answer`, `.composer-model`: the answer and the model name. */
internal val AgentAnswer = Color(0xFFE4E4E4)
/** `.banner`, `.history-list` rows. */
internal val AgentBannerText = Color(0xFFD6D6D6)
/** `.activity-step .step-title` of an open step. */
internal val AgentStepTitle = Color(0xFFC4C4C4)
/** `.log-stats`, `.log-signal`: diagnostic values. */
internal val AgentStat = Color(0xFFBDBDBD)
/** `.icon-btn`. */
internal val AgentIcon = Color(0xFFB0B0B0)
/** `.field > span`, a collapsed step title, `.activity-text`. */
internal val AgentLabel = Color(0xFFA0A0A0)
/** `.mic`: the composer's quiet button. */
internal val AgentQuietIcon = Color(0xFF999999)
/** `.step-icon`. */
internal val AgentStepIcon = Color(0xFF8A8A8A)
/** `.activity-phase`. */
internal val AgentPhase = Color(0xFF777777)
/** `.step-duration`, a disabled send arrow. */
internal val AgentStepMeta = Color(0xFF737373)
/** `.step-caret`, `.history-open > small`. */
internal val AgentSubtle = Color(0xFF6F6F6F)
/** `.settings-section h3`, `.hint`. */
internal val AgentHint = Color(0xFF6A6A6A)
/** `.activity-latest`, an idle `.dot`. */
internal val AgentDim = Color(0xFF555555)
/** `.footer`. */
internal val AgentFooter = Color(0xFF505050)
/** `.thinking-wait`. */
internal val AgentThinking = Color(0xFF8F8157)
/** `.secondary` border, `.send:disabled`, an unchecked switch. */
internal val AgentControl = Color(0xFF2A2A2A)
/** `.image-chips`, `.markdown-body code` borders. */
internal val AgentChipBorder = Color(0xFF2C2C2C)
/** `.step-body` dashed rule. */
internal val AgentRule = Color(0xFF333333)
/** `.top-actions`: translucent glass over the page, and the hairline around it. */
internal val AgentGlass = Color(0xB8262626)
internal val AgentGlassBorder = Color.White.copy(alpha = 0.09f)
/** `.slash-menu`, `.model-menu`: a floating surface. */
internal val AgentMenu = Color(0xF51E1E1E)
internal val AgentMenuBorder = Color.White.copy(alpha = 0.08f)

/**
 * Geist, the side panel's typeface (`--font`), bundled as one variable font so
 * the phone never needs the network for it. SIL OFL 1.1: assets/licenses/Geist-OFL.txt.
 */
private fun geist(weight: FontWeight) = Font(
    R.font.geist_variable,
    weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

internal val Geist = FontFamily(
    geist(FontWeight.Normal),
    geist(FontWeight.Medium),
    geist(FontWeight.SemiBold),
    geist(FontWeight.Bold),
)

/** CSS half-leading: extra line height is split above and below every line, first and last included. */
private val CssLeading = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/**
 * One side-panel text style. Sizes are the panel's CSS pixels as `sp`; the
 * panel's body weight is 500 and it uses no letter spacing unless a rule says so.
 * [line] is a CSS `line-height` multiple; leave it out for `normal`.
 */
internal fun agentType(
    size: Float,
    line: Float? = null,
    weight: FontWeight = FontWeight.Medium,
    tracking: TextUnit = 0.sp,
    family: FontFamily = Geist,
) = TextStyle(
    fontFamily = family,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = if (line == null) TextUnit.Unspecified else (size * line).sp,
    letterSpacing = tracking,
    lineHeightStyle = CssLeading,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

/** The panel's recurring text styles, named after the rules they come from. */
internal object AgentType {
    /** `.activity-answer`: 14px/1.65. */
    val Answer = agentType(14f, 1.65f)
    /** `.user-bubble`: 14px/1.55. */
    val Bubble = agentType(14f, 1.55f)
    /** `#input`: 14px/1.5. */
    val Input = agentType(14f, 1.5f)
    /** `.activity-entry`: 14px on a 24px line. */
    val Entry = agentType(14f, 24f / 14f)
    /** `.activity-step .step-title`, `.agent-turn-summary`. */
    val Step = agentType(14f, 20f / 14f)
    /** `.thinking-wait`, `.composer-model`, `.confirm-card-title`. */
    val Small = agentType(13f)
    /** `.banner`, `.confirm-card-action`: 12px/1.45. */
    val Note = agentType(12f, 1.45f)
    /** `.hint`: 12px/1.6. */
    val Hint = agentType(12f, 1.6f)
    /** `.step-duration`, `.link`, `.activity-phase`. */
    val Meta = agentType(12f)
    /** `.user-origin`, `.act-time`, `.recent-session-copy small`. */
    val Tiny = agentType(11f)
    /** `.confirm-card-badge`, `.plan-mode-badge`: 10px/600, uppercase, tracked. */
    val Badge = agentType(10f, weight = FontWeight.SemiBold, tracking = 0.04.em)
    /** `.secondary`: 12px/400. */
    val Button = agentType(12f, weight = FontWeight.Normal)
    /** `.primary`: 12px/500. */
    val ButtonPrimary = agentType(12f)
    /** `.modal-head h2`: 16px/500, tightened. */
    val Title = agentType(16f, weight = FontWeight.Medium, tracking = (-0.01).em)
    /** `.settings-section h3`: 13px/400. */
    val Section = agentType(13f, weight = FontWeight.Normal)
    /** `--mono` at the size the panel uses for commands and code. */
    val Mono = agentType(12f, 1.5f, weight = FontWeight.Normal, family = FontFamily.Monospace)
}

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
    tertiaryContainer = AgentYellowWash,
    onTertiaryContainer = AgentTextSoft,
)

/**
 * Material's slots mapped onto the panel's scale, so anything that falls back
 * to a slot (a text field, a dialog, a plain `Text`) is still Geist at a panel size.
 */
private val SidebarTypography = Typography(
    displayLarge = agentType(34f, 1.15f, FontWeight.Bold, (-0.02).em),
    displayMedium = agentType(30f, 1.15f, FontWeight.Bold, (-0.02).em),
    displaySmall = agentType(26f, 1.15f, FontWeight.Bold, (-0.02).em),
    headlineLarge = agentType(26f, 1.15f, FontWeight.Bold, (-0.02).em),
    headlineMedium = agentType(24f, 1.15f, FontWeight.Bold, (-0.02).em),
    // `.disclaimer h2`
    headlineSmall = agentType(23f, 1.15f, FontWeight.Bold, (-0.02).em),
    titleLarge = AgentType.Title,
    // `.markdown-body h3`
    titleMedium = agentType(15f, 1.4f, FontWeight.SemiBold),
    titleSmall = AgentType.Section,
    bodyLarge = AgentType.Answer,
    bodyMedium = AgentType.Input,
    bodySmall = AgentType.Note,
    labelLarge = AgentType.Small,
    labelMedium = AgentType.Meta,
    labelSmall = AgentType.Tiny,
)

@Composable
fun RemoteTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = SidebarColors, typography = SidebarTypography, content = content)
}
