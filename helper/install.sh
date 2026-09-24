#!/bin/sh
# Installs the Browser Agent native-messaging host for Chromium-family
# browsers (Chrome, Chromium, Edge, Brave). Safe to re-run.
set -e

HOST_NAME="browser_agent_helper"
HOST_PATH="$(cd "$(dirname "$0")" && pwd)/browser-agent-host"
EXT_ID="${1:-}"

if [ -z "$EXT_ID" ]; then
  echo "usage: install.sh <extension-id>" >&2
  echo "  (the unpacked extension id — shown in chrome://extensions)" >&2
  exit 1
fi

chmod +x "$HOST_PATH"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Browser Agent helper daemon (full-CDP bridge)",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

for dir in \
  "$HOME/.config/google-chrome/NativeMessagingHosts" \
  "$HOME/.config/chromium/NativeMessagingHosts" \
  "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
do
  if [ -d "$(dirname "$dir")" ]; then
    mkdir -p "$dir"
    printf '%s' "$MANIFEST" > "$dir/$HOST_NAME.json"
    echo "installed: $dir/$HOST_NAME.json"
  fi
done

echo "done. Restart the browser (or reload the extension) to pick it up."
