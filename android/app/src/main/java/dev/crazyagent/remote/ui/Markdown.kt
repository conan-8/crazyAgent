package dev.crazyagent.remote.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em

/** Vertical margins of one block, as `.markdown-body` sets them: top to bottom. */
private fun blockMargins(block: MarkdownBlock): Pair<Int, Int> = when (block) {
    is MarkdownBlock.Paragraph -> 0 to 12
    is MarkdownBlock.Heading -> 18 to 8
    is MarkdownBlock.Listing -> 8 to 14
    is MarkdownBlock.Quote -> 10 to 14
    is MarkdownBlock.Code -> 10 to 14
    is MarkdownBlock.Table -> 10 to 16
    MarkdownBlock.Rule -> 18 to 18
}

@Composable
fun MarkdownContent(text: String) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column {
        for ((index, block) in blocks.withIndex()) {
            // Adjoining margins collapse to the larger one, and the first and last have none.
            if (index > 0) Spacer(Modifier.height(maxOf(blockMargins(blocks[index - 1]).second, blockMargins(block).first).dp))
            when (block) {
                is MarkdownBlock.Paragraph -> MarkdownInlineText(block.text)
                // The panel renders #, ##, and ### alike (h3-h5): 15px/600.
                is MarkdownBlock.Heading -> MarkdownInlineText(block.text, style = MaterialTheme.typography.titleMedium.copy(color = AgentText))
                is MarkdownBlock.Listing -> Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    for (item in block.items) {
                        Row(verticalAlignment = Alignment.Top) {
                            Text(
                                item.marker,
                                style = AgentType.Answer,
                                color = AgentYellow,
                                fontWeight = FontWeight.SemiBold,
                                textAlign = TextAlign.End,
                                modifier = Modifier.width(27.dp).padding(end = 6.dp),
                            )
                            MarkdownInlineText(item.text, modifier = Modifier.weight(1f))
                        }
                    }
                }
                is MarkdownBlock.Quote -> MarkdownInlineText(
                    block.text,
                    style = AgentType.Answer.copy(color = Color(0xFFB8B8B8)),
                    modifier = Modifier
                        .fillMaxWidth()
                        .drawBehind { drawRect(AgentYellow, size = Size(2.dp.toPx(), size.height)) }
                        .padding(start = 14.dp, top = 2.dp, bottom = 2.dp),
                )
                is MarkdownBlock.Code -> Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MarkdownSurface,
                    border = BorderStroke(1.dp, AgentChipBorder),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (block.language.isNotEmpty()) Text(block.language, style = AgentType.Tiny, color = AgentFaint)
                        Text(
                            block.text,
                            style = AgentType.Mono,
                            color = AgentBannerText,
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

/** `.markdown-body table` and its code blocks sit on a surface slightly darker than a panel. */
private val MarkdownSurface = Color(0xFF171717)
private val TableCell = agentType(13f, 1.45f)

/**
 * `.markdown-table-wrap` around a `width: 100%` table: columns are sized by
 * their content, the table is never narrower than the chat, and it scrolls
 * sideways only when even the narrowest columns do not fit.
 */
@Composable
private fun MarkdownTable(table: MarkdownBlock.Table) {
    val columns = maxOf(table.headers.size, table.rows.maxOfOrNull { it.size } ?: 0).coerceAtLeast(1)
    fun cells(row: List<String>): List<String> = List(columns) { index -> row.getOrElse(index) { "" } }
    val shape = RoundedCornerShape(10.dp)
    BoxWithConstraints(
        Modifier.fillMaxWidth().clip(shape).background(MarkdownSurface).border(1.dp, AgentChipBorder, shape).padding(1.dp),
    ) {
        val viewport = constraints.maxWidth
        Layout(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            content = {
                // Drawn in this order: the header's fill and the row rules sit under the cells.
                Box(Modifier.background(Color(0xFF202020)))
                repeat(table.rows.size) { Box(Modifier.background(AgentChipBorder)) }
                for ((index, value) in cells(table.headers).withIndex()) {
                    MarkdownInlineText(
                        value,
                        style = TableCell.copy(color = AgentText, fontWeight = FontWeight.SemiBold),
                        textAlign = tableAlign(table.aligns, index),
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
                for (row in table.rows) {
                    for ((index, value) in cells(row).withIndex()) {
                        MarkdownInlineText(
                            value,
                            style = TableCell.copy(color = Color(0xFFCFCFCF)),
                            textAlign = tableAlign(table.aligns, index),
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                        )
                    }
                }
            },
        ) { measurables, _ ->
            val rowCount = table.rows.size + 1
            val decorations = 1 + table.rows.size
            val cellMeasurables = measurables.drop(decorations)
            val narrowest = IntArray(columns)
            val widest = IntArray(columns)
            for ((index, cell) in cellMeasurables.withIndex()) {
                val column = index % columns
                narrowest[column] = maxOf(narrowest[column], cell.minIntrinsicWidth(Constraints.Infinity))
                widest[column] = maxOf(widest[column], cell.maxIntrinsicWidth(Constraints.Infinity))
            }
            val widths = tableColumnWidths(narrowest, widest, viewport)
            val tableWidth = widths.sum()
            val placeables = cellMeasurables.mapIndexed { index, cell -> cell.measure(Constraints.fixedWidth(widths[index % columns])) }
            val heights = IntArray(rowCount) { row -> (0 until columns).maxOf { column -> placeables[row * columns + column].height } }
            val rule = 1.dp.roundToPx()
            val headerFill = measurables[0].measure(Constraints.fixed(tableWidth, heights[0]))
            val rules = (1..table.rows.size).map { measurables[it].measure(Constraints.fixed(tableWidth, rule)) }
            layout(tableWidth, heights.sum() + rule * table.rows.size) {
                headerFill.place(0, 0)
                var y = 0
                for (row in 0 until rowCount) {
                    if (row > 0) {
                        rules[row - 1].place(0, y)
                        y += rule
                    }
                    var x = 0
                    for (column in 0 until columns) {
                        placeables[row * columns + column].place(x, y)
                        x += widths[column]
                    }
                    y += heights[row]
                }
            }
        }
    }
}

/**
 * Column widths for a table that wants to be [available] wide, the way a
 * browser lays out an auto table. [narrowest] is each column with every line
 * broken (its longest word) and [widest] is each column on one line. When
 * everything fits on one line the spare room is shared in proportion to
 * content; otherwise columns shrink toward their narrowest, and below that
 * the table is simply wider than [available].
 */
internal fun tableColumnWidths(narrowest: IntArray, widest: IntArray, available: Int): IntArray {
    val count = widest.size
    if (count == 0) return IntArray(0)
    val widestTotal = widest.sum()
    val narrowestTotal = narrowest.sum()
    val widths = when {
        widestTotal <= available -> {
            val spare = available - widestTotal
            IntArray(count) { widest[it] + if (widestTotal > 0) (spare.toLong() * widest[it] / widestTotal).toInt() else spare / count }
        }
        narrowestTotal >= available -> narrowest.copyOf()
        else -> {
            val spare = available - narrowestTotal
            val stretch = widestTotal - narrowestTotal
            IntArray(count) { narrowest[it] + (spare.toLong() * (widest[it] - narrowest[it]) / stretch).toInt() }
        }
    }
    // Whole pixels lost to rounding go to the last column, so the table still spans the chat.
    if (narrowestTotal < available) widths[count - 1] += available - widths.sum()
    return widths
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
    style: TextStyle = AgentType.Answer.copy(color = AgentAnswer),
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
            token.startsWith("**") || token.startsWith("__") -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = AgentText)) {
                append(token.substring(2, token.length - 2))
            }
            token.startsWith('`') -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 0.9.em, fontWeight = FontWeight.Normal, background = Color(0xFF1C1C1C), color = AgentBannerText)) {
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
                    withStyle(SpanStyle(color = AgentYellow)) {
                        append(parts.groupValues[1])
                    }
                    addLink(LinkAnnotation.Url(parts.groupValues[2], TextLinkStyles(style = SpanStyle(color = AgentYellow))), start, length)
                }
            }
        }
        offset = match.range.last + 1
    }
    append(text.substring(offset))
}
