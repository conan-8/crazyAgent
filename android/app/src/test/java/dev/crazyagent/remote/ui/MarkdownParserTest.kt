package dev.crazyagent.remote.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {
    @Test fun parsesSidebarStyleBlocks() {
        val blocks = parseMarkdown(
            "# Heading\n\nA paragraph with **bold**.\n\n- First bullet\n- Second bullet\n\n1. First numbered\n2. Second numbered\n\n> A quote\n\n```kotlin\nval answer = 42\n```\n\n| Plan | Price |\n| --- | ---: |\n| Pro | $24 |\n\n---",
        )
        assertEquals(
            listOf("Heading", "Paragraph", "Listing", "Listing", "Quote", "Code", "Table", "Rule"),
            blocks.map { it::class.simpleName },
        )
        assertEquals(MarkdownBlock.Heading(1, "Heading"), blocks[0])
        assertEquals(listOf("•", "•"), (blocks[2] as MarkdownBlock.Listing).items.map { it.marker })
        assertEquals(listOf("1.", "2."), (blocks[3] as MarkdownBlock.Listing).items.map { it.marker })
        assertEquals(MarkdownBlock.Code("kotlin", "val answer = 42"), blocks[5])
        val table = blocks[6] as MarkdownBlock.Table
        assertEquals(listOf("Plan", "Price"), table.headers)
        assertEquals(listOf(listOf("Pro", "$24")), table.rows)
        assertEquals(listOf(MarkdownAlign.LEFT, MarkdownAlign.RIGHT), table.aligns)
    }

    @Test fun preservesParagraphsAndUnmatchedMarkers() {
        val blocks = parseMarkdown("First line\nSecond line\n\nThis is **not closed")
        assertEquals(listOf(MarkdownBlock.Paragraph("First line\nSecond line"), MarkdownBlock.Paragraph("This is **not closed")), blocks)
        assertEquals("This is **not closed", markdownInline("This is **not closed").text)
    }

    @Test fun inlineFormattingHasStylesAndSafeLinkAnnotations() {
        val text = markdownInline("**bold** *italic* `code` [site](https://example.com) [bad](javascript:alert(1))")
        assertEquals("bold italic code site [bad](javascript:alert(1))", text.text)
        assertTrue(text.spanStyles.size >= 4)
        val link = text.getLinkAnnotations(0, text.length).single()
        assertEquals("https://example.com", (link.item as androidx.compose.ui.text.LinkAnnotation.Url).url)
        assertEquals("site", text.text.substring(link.start, link.end))
    }

    @Test fun fencedCodeKeepsMarkerTextLiteral() {
        val blocks = parseMarkdown("```text\n**not bold**\n- not a list\n```")
        assertEquals(listOf(MarkdownBlock.Code("text", "**not bold**\n- not a list")), blocks)
    }
}
