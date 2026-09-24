#!/bin/sh
# Prepares the dedicated automation profile for Unlimited mode and (optionally)
# launches the browser with full CDP enabled.
#
# Why a cloned profile: since Chrome 136, --remote-debugging-port is IGNORED on
# the default user-data-dir (anti-cookie-theft hardening). Unlimited mode thus
# runs a non-default profile. This script clones the default profile's
# logins/cookies into it (works on Linux where profile encryption is tied to
# the user keyring; on other platforms you may need to log in once).
set -e

SRC="${1:-$HOME/.config/google-chrome}"
DST="${2:-$HOME/.config/browser-agent/profile}"

if [ -d "$DST" ]; then
  echo "profile already exists: $DST (delete it to re-clone)"
else
  mkdir -p "$DST"
  # Copy the parts that carry logins: Default profile dir + Local State.
  cp -a "$SRC/Default" "$DST/Default" 2>/dev/null || true
  cp -a "$SRC/Local State" "$DST/Local State" 2>/dev/null || true
  echo "cloned $SRC → $DST"
fi

echo "launch flags for full CDP (the helper daemon's 'launch' op uses these):"
echo "  --user-data-dir=$DST --remote-debugging-port=0"
echo "note: first run may require signing in once inside this profile."
