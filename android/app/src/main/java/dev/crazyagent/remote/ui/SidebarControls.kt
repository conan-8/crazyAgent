package dev.crazyagent.remote.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** `.icon-btn`: a 34px round button with a 17px line icon. */
@Composable
internal fun AgentIconButton(
    icon: ImageVector,
    description: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    size: Dp = 34.dp,
    iconSize: Dp = 17.dp,
    tint: Color = AgentIcon,
) {
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = tint.copy(alpha = if (enabled) tint.alpha else tint.alpha * 0.4f), modifier = Modifier.size(iconSize))
    }
}

/** `.close-btn`: the 36px bordered round button in a panel's header. */
@Composable
internal fun AgentCloseButton(description: String, onClick: () -> Unit) {
    AgentIconButton(
        AppIcons.Close,
        description,
        onClick,
        modifier = Modifier.background(Color.White.copy(alpha = 0.055f), CircleShape).border(1.dp, AgentGlassBorder, CircleShape),
        size = 36.dp,
        iconSize = 16.dp,
    )
}

/**
 * `.primary` / `.secondary`: a 36px pill with 12px text. [wide] is the panel's
 * full-width form (`.disclaimer-dismiss`): 38px tall with 13px text.
 */
@Composable
internal fun AgentButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
    loading: Boolean = false,
    wide: Boolean = false,
    leading: (@Composable RowScope.() -> Unit)? = null,
) {
    val content = when {
        primary -> AgentBackground
        danger -> AgentDanger
        else -> AgentTextSoft
    }
    val shape = RoundedCornerShape(50)
    val base = if (primary) AgentType.ButtonPrimary else AgentType.Button
    Row(
        modifier
            .then(if (wide) Modifier.fillMaxWidth() else Modifier)
            .height(if (wide) 38.dp else 36.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .clip(shape)
            .then(
                if (primary) {
                    Modifier.background(AgentYellow)
                } else {
                    Modifier.border(1.dp, if (danger) AgentDanger.copy(alpha = 0.45f) else AgentControl, shape)
                },
            )
            .clickable(enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = content)
        } else {
            leading?.invoke(this)
            Text(text, style = if (wide) base.copy(fontSize = AgentType.Small.fontSize) else base, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * `.link`: 12px yellow text. The padding around it is touch area only, so a
 * row that holds one should give up the same amount of its own padding.
 */
@Composable
internal fun AgentLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Text(
        text,
        style = AgentType.Meta,
        color = if (enabled) AgentYellow else AgentFaint,
        maxLines = 1,
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

/** `.confirm-card-badge`, `.plan-mode-badge`: a small uppercase yellow pill. */
@Composable
internal fun AgentBadge(text: String, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(50)
    Text(
        text.uppercase(),
        style = AgentType.Badge,
        color = AgentYellow,
        maxLines = 1,
        modifier = modifier
            .background(AgentYellowSoft, shape)
            .border(1.dp, AgentYellow.copy(alpha = 0.35f), shape)
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

/**
 * `.field input`, `.history-search input`: a 38px single-line input with an
 * 11px radius, whose border turns yellow while it has focus.
 */
@Composable
internal fun AgentField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    leadingIcon: ImageVector? = null,
    container: Color = AgentPanel,
    textStyle: androidx.compose.ui.text.TextStyle = AgentType.Small,
    isError: Boolean = false,
    enabled: Boolean = true,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val border by animateColorAsState(
        when {
            isError -> AgentDanger.copy(alpha = 0.7f)
            focused -> AgentYellow.copy(alpha = 0.45f)
            else -> AgentBorder
        },
        Motion.fast(),
        label = "field-border",
    )
    val shape = RoundedCornerShape(11.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().height(38.dp).background(container, shape).border(1.dp, border, shape),
        enabled = enabled,
        singleLine = true,
        textStyle = textStyle.copy(color = if (enabled) AgentText else AgentMuted),
        cursorBrush = SolidColor(AgentYellow),
        visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions,
        interactionSource = interaction,
        decorationBox = { inner ->
            Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (leadingIcon != null) {
                    Icon(leadingIcon, contentDescription = null, tint = Color(0xFF7D7D7D), modifier = Modifier.padding(end = 8.dp).size(14.dp))
                }
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(placeholder, style = textStyle, color = AgentFaint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
            }
        },
    )
}

/** A confirmation dialog on the panel's floating surface, with its pill buttons. */
@Composable
internal fun AgentAlert(
    title: String,
    text: String,
    confirm: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    dismiss: String? = "Cancel",
    danger: Boolean = false,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = RoundedCornerShape(18.dp),
        containerColor = AgentPanelRaised,
        tonalElevation = 0.dp,
        title = { Text(title, style = AgentType.Title, color = AgentText) },
        text = { Text(text, style = agentType(13f, 1.55f, weight = androidx.compose.ui.text.font.FontWeight.Normal), color = AgentTextSoft) },
        confirmButton = { AgentButton(confirm, onConfirm, primary = !danger, danger = danger, modifier = Modifier.defaultMinSize(minWidth = 84.dp)) },
        dismissButton = dismiss?.let { label -> { AgentButton(label, onDismiss, modifier = Modifier.defaultMinSize(minWidth = 84.dp)) } },
    )
}

/** `.step-body`: a 1px dashed rule down the start edge. */
internal fun Modifier.dashedStartRule(color: Color = AgentRule): Modifier = drawBehind {
    val stroke = 1.dp.toPx()
    drawLine(
        color = color,
        start = Offset(stroke / 2, 0f),
        end = Offset(stroke / 2, size.height),
        strokeWidth = stroke,
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())),
    )
}
