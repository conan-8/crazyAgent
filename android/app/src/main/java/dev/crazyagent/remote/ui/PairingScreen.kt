package dev.crazyagent.remote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.crazyagent.remote.app.Screen

@Composable
fun PairingScreen(
    screen: Screen.Pairing,
    onPair: (url: String, token: String) -> Unit,
    onCancel: () -> Unit,
) {
    var url by rememberSaveable { mutableStateOf(screen.url) }
    // The token is deliberately not saved in instance state.
    var token by androidx.compose.runtime.remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(28.dp))
        Icon(AppIcons.Cursor, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(56.dp))
        Spacer(Modifier.height(18.dp))
        Text("Connect to crazyAgent", style = MaterialTheme.typography.headlineSmall, color = AgentText, textAlign = TextAlign.Center)
        Text(
            "Control the browser agent in your desktop side panel from this phone.",
            style = agentType(13f, 1.55f, FontWeight.Normal),
            color = AgentMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp).padding(top = 8.dp, bottom = 24.dp),
        )
        val shape = RoundedCornerShape(18.dp)
        Column(
            Modifier.fillMaxWidth().background(AgentPanel, shape).border(1.dp, AgentBorder, shape).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                "Start the companion with --remote, then run --pair-remote on the computer. Connect this phone to Tailscale first.",
                style = AgentType.Hint,
                color = AgentMuted,
            )
            Text(
                "npm run dev -- --pair-remote",
                style = AgentType.Mono,
                color = AgentBannerText,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(AgentBackground, RoundedCornerShape(10.dp))
                    .border(1.dp, AgentChipBorder, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            )
            PairingField(
                label = "Server address",
                value = url,
                onValueChange = { url = it },
                placeholder = "https://host.tailnet.ts.net",
                error = screen.urlError,
                enabled = !screen.busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            )
            PairingField(
                label = "Remote token",
                value = token,
                onValueChange = { token = it },
                placeholder = "",
                error = screen.tokenError,
                enabled = !screen.busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
            )
            screen.error?.let {
                Text(it, color = AgentDanger, style = AgentType.Note, modifier = Modifier.semantics { contentDescription = "Pairing error: $it" })
            }
            AgentButton("Connect", { onPair(url, token) }, primary = true, wide = true, enabled = !screen.busy, loading = screen.busy)
            if (screen.canCancel) {
                AgentButton("Cancel", onCancel, wide = true, enabled = !screen.busy)
            }
        }
        Text(
            "Your token is encrypted with this phone's keystore and is only sent to this server.",
            style = AgentType.Hint,
            color = AgentHint,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp).padding(horizontal = 12.dp, vertical = 18.dp),
        )
    }
}

/** `.field`: a 13px label over a 38px input, with any error below it. */
@Composable
private fun PairingField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    error: String?,
    enabled: Boolean,
    keyboardOptions: KeyboardOptions,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(label, style = AgentType.Small, color = AgentLabel)
        AgentField(
            value = value,
            onValueChange = onValueChange,
            placeholder = placeholder,
            container = AgentBackground,
            isError = error != null,
            enabled = enabled,
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            modifier = Modifier.semantics { contentDescription = label },
        )
        if (error != null) Text(error, style = AgentType.Note, color = AgentDanger)
    }
}
