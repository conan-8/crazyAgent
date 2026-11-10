package dev.crazyagent.remote.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
        Icon(AppIcons.Cursor, contentDescription = null, tint = AgentYellow, modifier = Modifier.size(64.dp))
        Spacer(Modifier.height(18.dp))
        Text("Connect to crazyAgent", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "Control the browser agent in your desktop side panel from this phone.",
            style = MaterialTheme.typography.bodyMedium,
            color = AgentMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp, bottom = 26.dp),
        )
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = AgentPanel,
            border = BorderStroke(1.dp, AgentBorder),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(
                    "Start the companion with --remote, then run --pair-remote on the computer. Connect this phone to Tailscale first.",
                    style = MaterialTheme.typography.bodySmall,
                    color = AgentMuted,
                )
                Surface(shape = RoundedCornerShape(10.dp), color = AgentPanelRaised, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "npm run dev -- --pair-remote",
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        color = AgentTextSoft,
                        modifier = Modifier.padding(12.dp),
                    )
                }
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Server address") },
                    placeholder = { Text("https://host.tailnet.ts.net") },
                    singleLine = true,
                    isError = screen.urlError != null,
                    supportingText = screen.urlError?.let { { Text(it) } },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !screen.busy,
                    colors = pairingFieldColors(),
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("Remote token") },
                    singleLine = true,
                    isError = screen.tokenError != null,
                    supportingText = screen.tokenError?.let { { Text(it) } },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !screen.busy,
                    colors = pairingFieldColors(),
                )
                screen.error?.let {
                    Text(it, color = AgentDanger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { contentDescription = "Pairing error: $it" })
                }
                Button(
                    onClick = { onPair(url, token) },
                    enabled = !screen.busy,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = AgentYellow, contentColor = AgentBackground),
                    modifier = Modifier.fillMaxWidth().height(46.dp),
                ) {
                    if (screen.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = AgentBackground) else Text("Connect")
                }
                if (screen.canCancel) {
                    TextButton(onClick = onCancel, enabled = !screen.busy, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
                }
            }
        }
        Text(
            "Your token is encrypted with this phone's keystore and is only sent to this server.",
            style = MaterialTheme.typography.bodySmall,
            color = AgentFaint,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 18.dp),
        )
    }
}

@Composable
private fun pairingFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = AgentYellow,
    unfocusedBorderColor = AgentBorder,
    focusedLabelColor = AgentYellow,
    unfocusedLabelColor = AgentMuted,
    focusedTextColor = AgentText,
    unfocusedTextColor = AgentText,
    cursorColor = AgentYellow,
    focusedContainerColor = AgentBackground,
    unfocusedContainerColor = AgentBackground,
)
