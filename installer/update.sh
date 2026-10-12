#!/bin/sh
# Replaces this install with the newest release zip; you then press the reload
# arrow in chrome://extensions. Safe to re-run.
#
# The install directory never moves, which is the point: Chromium derives an
# unpacked extension's id from the sha256 of its absolute path, so keeping the
# path keeps the id — and with it the browser storage holding your
# conversations and settings, plus the native-host manifest's allowed_origins.
#
# Usage: sh update.sh [zip-path-or-url]
#   no argument  download the latest GitHub Release asset
#   a path/url   update from that zip instead (local builds, air-gapped, tests)
set -e

URL="https://github.com/conan-8/crazyAgent/releases/latest/download/crazyagent.zip"
SRC="${1:-$URL}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="${TMPDIR:-/tmp}/crazyagent-update-$$"
ZIP="$TMP.zip"

cleanup() { rm -rf "$TMP" "$ZIP"; }
trap cleanup EXIT INT TERM

command -v unzip >/dev/null 2>&1 || {
  echo "update.sh needs unzip" >&2
  exit 1
}

case "$SRC" in
  /* | ./*)
    [ -f "$SRC" ] || { echo "no such zip: $SRC" >&2; exit 1; }
    cp "$SRC" "$ZIP"
    ;;
  *)
    command -v curl >/dev/null 2>&1 || {
      echo "update.sh needs curl to download (or pass a local zip path)" >&2
      exit 1
    }
    echo "downloading $SRC"
    if ! curl -fsSL --retry 2 -o "$ZIP" "$SRC"; then
      echo "download failed: $SRC" >&2
      echo "no release published yet? pass a local zip path instead" >&2
      exit 1
    fi
    ;;
esac

unzip -tq "$ZIP" >/dev/null || { echo "not a valid zip: $SRC" >&2; exit 1; }

rm -rf "$TMP"
mkdir -p "$TMP"
unzip -q "$ZIP" -d "$TMP"
[ -f "$TMP/dist/manifest.json" ] || {
  echo "that zip has no dist/manifest.json — not a crazyAgent release" >&2
  exit 1
}

# Unpack beside the install and rename into place. `unzip -o` over the live
# directory would truncate this script while sh is still reading it, and would
# leave behind any file the new build no longer ships; renaming swaps the whole
# tree and keeps the running script's inode alive.
for item in dist helper update.sh README.txt; do
  [ -e "$TMP/$item" ] || continue
  rm -rf "$DIR/$item"
  mv "$TMP/$item" "$DIR/$item"
done

STAMP=$(sed -n 's/.*"version_name": *"\([^"]*\)".*/\1/p' "$DIR/dist/manifest.json")
echo "replaced $DIR with build ${STAMP:-unknown}"
echo "now press the reload arrow on crazyAgent's card in chrome://extensions"
