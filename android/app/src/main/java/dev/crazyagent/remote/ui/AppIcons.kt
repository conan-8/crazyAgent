package dev.crazyagent.remote.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

private fun lineIcon(data: String): ImageVector = ImageVector.Builder(
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).addPath(
    pathData = addPathNodes(data),
    fill = null,
    stroke = SolidColor(Color.Black),
    strokeLineWidth = 1.8f,
    strokeLineCap = StrokeCap.Round,
    strokeLineJoin = StrokeJoin.Round,
).build()

internal object AppIcons {
    val Plus = lineIcon("M12 5v14M5 12h14")
    val History = lineIcon("M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2")
    val Close = lineIcon("m6 6 12 12M18 6 6 18")
    val Chevron = lineIcon("m7 10 5 5 5-5")
    val ArrowUp = lineIcon("m6 11 6-6 6 6M12 5v14")
    val Refresh = lineIcon("M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5")
    val Diagnostics = lineIcon("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h6")
    val Settings = lineIcon("M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3V3h4v.08a1.7 1.7 0 0 0 1.06 1.52 1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1ZM12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6")
    val Attachment = lineIcon("m20.4 11.6-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.9-2.8l7.8-7.8")
    val Expand = lineIcon("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")
    val Tool = lineIcon("m4 3 7.2 18 2.6-7.4L21 11 4 3ZM15 2v3M19 4l2-2M20 9h3M5 5 3 3")
    val Cursor: ImageVector = ImageVector.Builder(
        defaultWidth = 32.dp,
        defaultHeight = 32.dp,
        viewportWidth = 32f,
        viewportHeight = 32f,
    ).addPath(
        pathData = addPathNodes("M2.2 2.2 29.8 15.8 15.2 17.4 12.4 29.8Z"),
        fill = SolidColor(Color.Black),
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 1.4f,
        strokeLineJoin = StrokeJoin.Round,
    ).build()
}
