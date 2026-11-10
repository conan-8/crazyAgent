package dev.crazyagent.remote.ui

sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class Listing(val ordered: Boolean, val items: List<MarkdownListItem>) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val language: String, val text: String) : MarkdownBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>, val aligns: List<MarkdownAlign>) : MarkdownBlock
    data object Rule : MarkdownBlock
}

data class MarkdownListItem(val marker: String, val text: String)
enum class MarkdownAlign { LEFT, CENTER, RIGHT }

fun parseMarkdown(source: String): List<MarkdownBlock> {
    val lines = source.replace(Regex("\r\n?"), "\n").split('\n')
    val blocks = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()

    fun flushParagraph() {
        if (paragraph.isEmpty()) return
        blocks += MarkdownBlock.Paragraph(paragraph.joinToString("\n"))
        paragraph.clear()
    }

    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        if (line.isBlank()) {
            flushParagraph()
            index += 1
            continue
        }

        val fence = Regex("^\\s*(```|~~~)\\s*([^ ]*)\\s*$").find(line)
        if (fence != null) {
            flushParagraph()
            val marker = fence.groupValues[1]
            val language = fence.groupValues[2]
            val code = mutableListOf<String>()
            index += 1
            while (index < lines.size && !Regex("^\\s*$marker\\s*$").matches(lines[index])) {
                code += lines[index]
                index += 1
            }
            if (index < lines.size) index += 1
            blocks += MarkdownBlock.Code(language, code.joinToString("\n"))
            continue
        }

        if (index + 1 < lines.size && line.contains('|') && isTableDivider(lines[index + 1])) {
            flushParagraph()
            val headers = tableCells(line)
            val aligns = tableCells(lines[index + 1]).map { cell ->
                when {
                    cell.startsWith(':') && cell.endsWith(':') -> MarkdownAlign.CENTER
                    cell.endsWith(':') -> MarkdownAlign.RIGHT
                    else -> MarkdownAlign.LEFT
                }
            }
            index += 2
            val rows = mutableListOf<List<String>>()
            while (index < lines.size && lines[index].isNotBlank() && lines[index].contains('|')) {
                rows += tableCells(lines[index])
                index += 1
            }
            blocks += MarkdownBlock.Table(headers, rows, aligns)
            continue
        }

        val heading = Regex("^(#{1,6})\\s+(.+)$").find(line)
        if (heading != null) {
            flushParagraph()
            blocks += MarkdownBlock.Heading(heading.groupValues[1].length, heading.groupValues[2])
            index += 1
            continue
        }

        val list = Regex("^\\s*([-+*]|\\d+[.)])\\s+(.+)$").find(line)
        if (list != null) {
            flushParagraph()
            val ordered = list.groupValues[1].first().isDigit()
            val items = mutableListOf<MarkdownListItem>()
            while (index < lines.size) {
                val item = Regex("^\\s*([-+*]|\\d+[.)])\\s+(.+)$").find(lines[index]) ?: break
                if (item.groupValues[1].first().isDigit() != ordered) break
                items += MarkdownListItem(if (ordered) item.groupValues[1] else "•", item.groupValues[2])
                index += 1
            }
            blocks += MarkdownBlock.Listing(ordered, items)
            continue
        }

        val quote = Regex("^\\s*>\\s?(.*)$").find(line)
        if (quote != null) {
            flushParagraph()
            val quoted = mutableListOf<String>()
            while (index < lines.size) {
                val part = Regex("^\\s*>\\s?(.*)$").find(lines[index]) ?: break
                quoted += part.groupValues[1]
                index += 1
            }
            blocks += MarkdownBlock.Quote(quoted.joinToString("\n"))
            continue
        }

        if (Regex("^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$").matches(line)) {
            flushParagraph()
            blocks += MarkdownBlock.Rule
            index += 1
            continue
        }

        paragraph += line
        index += 1
    }
    flushParagraph()
    return blocks
}

private fun tableCells(line: String): List<String> = line.trim().removePrefix("|").removeSuffix("|").split('|').map { it.trim() }

private fun isTableDivider(line: String): Boolean =
    Regex("^\\s*\\|?\\s*:?-{3,}:?\\s*(?:\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$").matches(line)
