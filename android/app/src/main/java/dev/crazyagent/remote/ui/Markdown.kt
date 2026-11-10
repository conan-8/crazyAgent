package dev.crazyagent.remote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun MarkdownContent(text: String) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (block in blocks) {
            when (block) {
                is MarkdownBlock.Paragraph -> MarkdownInlineText(block.text)
                is MarkdownBlock.Heading -> MarkdownInlineText(
                    block.text,
                    style = MaterialTheme.typography.bodyLarge.copy(
                        color = AgentText,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = when (block.level) {
                            1 -> 20.sp
                            2 -> 18.sp
                            else -> 16.sp
                        },
                        lineHeight = 24.sp,
                    ),
                )
                is MarkdownBlock.Listing -> Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    for (item in block.items) {
                        Row(verticalAlignment = Alignment.Top) {
                            Text(
                                item.marker,
                                style = MaterialTheme.typography.bodyMedium,
                                color = AgentYellow,
                                fontWeight = FontWeight.SemiBold,
                                textAlign = TextAlign.End,
                                modifier = Modifier.width(25.dp).padding(end = 8.dp),
                            )
                            MarkdownInlineText(item.text, modifier = Modifier.weight(1f))
                        }
                    }
                }
                is MarkdownBlock.Quote -> Row {
                    Box(Modifier.width(2.dp).heightIn(min = 24.dp).background(AgentYellow))
                    MarkdownInlineText(
                        block.text,
                        style = MaterialTheme.typography.bodyMedium.copy(color = AgentTextSoft, lineHeight = 22.sp),
                        modifier = Modifier.padding(start = 12.dp).weight(1f),
                    )
                }
                is MarkdownBlock.Code -> Surface(shape = RoundedCornerShape(10.dp), color = AgentPanel, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(11.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (block.language.isNotEmpty()) Text(block.language, style = MaterialTheme.typography.labelSmall, color = AgentFaint)
                        Text(
                            block.text,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = AgentTextSoft,
                            modifier = Modifier.horizontalScroll(rememberScrollState()),
                        )
                    }
                }
                is MarkdownBlock.Table -> MarkdownTable(block)
                MarkdownBlock.Rule -> HorizontalDivider(color = AgentBorder)
            }
        }
    }
}

@Composable
private fun MarkdownTable(table: MarkdownBlock.Table) {
    val columns = maxOf(table.headers.size, table.rows.maxOfOrNull { it.size } ?: 0).coerceAtLeast(1)
    fun cells(row: List<String>): List<String> = List(columns) { index -> row.getOrElse(index) { "" } }
    Surface(shape = RoundedCornerShape(10.dp), color = AgentPanel, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.horizontalScroll(rememberScrollState()).widthIn(min = 480.dp)) {
            Row(Modifier.background(AgentPanelRaised)) {
                for ((index, value) in cells(table.headers).withIndex()) {
                    MarkdownInlineText(
                        value,
                        style = MaterialTheme.typography.bodySmall.copy(color = AgentText, fontWeight = FontWeight.SemiBold, lineHeight = 19.sp),
                        textAlign = tableAlign(table.aligns, index),
                        modifier = Modifier.weight(1f).padding(8.dp),
                    )
                }
            }
            for (row in table.rows) {
                HorizontalDivider(color = AgentBorder)
                Row {
                    for ((index, value) in cells(row).withIndex()) {
                        MarkdownInlineText(
                            value,
                            style = MaterialTheme.typography.bodySmall.copy(color = AgentTextSoft, lineHeight = 19.sp),
                            textAlign = tableAlign(table.aligns, index),
                            modifier = Modifier.weight(1f).padding(8.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun tableAlign(aligns: List<MarkdownAlign>, index: Int): TextAlign = when (aligns.getOrElse(index) { MarkdownAlign.LEFT }) {
    MarkdownAlign.LEFT -> TextAlign.Start
    MarkdownAlign.CENTER -> TextAlign.Center
    MarkdownAlign.RIGHT -> TextAlign.End
}

@Composable
private fun MarkdownInlineText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium.copy(color = AgentText, lineHeight = 22.sp),
    textAlign: TextAlign = TextAlign.Start,
) {
    val annotated = remember(text) { markdownInline(text) }
    Text(
        text = annotated,
        style = style,
        textAlign = textAlign,
        modifier = modifier,
    )
}

internal fun markdownInline(text: String): AnnotatedString = buildAnnotatedString {
    val pattern = Regex("(\\*\\*[^*]+\\*\\*|__[^_]+__|`[^`]+`|\\*[^*\\n]+\\*|_[^_\\n]+_|\\[[^\\]]+\\]\\((?:https?://|mailto:)[^)\\s]+\\))")
    var offset = 0
    for (match in pattern.findAll(text)) {
        append(text.substring(offset, match.range.first))
        val token = match.value
        when {
            token.startsWith("**") || token.startsWith("__") -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
                append(token.substring(2, token.length - 2))
            }
            token.startsWith('`') -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = AgentPanel, color = AgentTextSoft)) {
                append(token.substring(1, token.length - 1))
            }
            token.startsWith('*') || token.startsWith('_') -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                append(token.substring(1, token.length - 1))
            }
            else -> {
                val parts = Regex("^\\[([^\\]]+)\\]\\(([^)]+)\\)$").find(token)
                if (parts == null) {
                    append(token)
                } else {
                    val start = length
                    withStyle(SpanStyle(color = AgentYellow, textDecoration = TextDecoration.Underline)) {
                        append(parts.groupValues[1])
                    }
                    addLink(LinkAnnotation.Url(parts.groupValues[2]), start, length)
                }
            }
        }
        offset = match.range.last + 1
    }
    append(text.substring(offset))
}
