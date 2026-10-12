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
#   no argument  newest release (stable, else the newest pre-release)
#   a path/url   update from that zip instead (local builds, air-gapped, tests)
set -e

REPO="conan-8/crazyAgent"
ASSET="crazyagent.zip"
LATEST="https://github.com/$REPO/releases/latest/download/$ASSET"
API="https://api.github.com/repos/$REPO/releases?per_page=1"
SRC="${1:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="${TMPDIR:-/tmp}/crazyagent-update-$$"
ZIP="$TMP.zip"

cleanup() { rm -rf "$TMP" "$ZIP"; }
trap cleanup EXIT INT TERM

command -v unzip >/dev/null 2>&1 || {
  echo "update.sh needs unzip" >&2
  exit 1
}

download() {
  curl -fsSL --retry 2 -o "$ZIP" "$1"
}

# Newest published release's asset, pre-releases included — the API route, for
# as long as there is no stable release for $LATEST to resolve to.
newest_url() {
  curl -fsSL "$API" |
    tr ',' '\n' |
    sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' |
    grep "/$ASSET\$" |
    head -1
}

case "$SRC" in
  "")
    command -v curl >/dev/null 2>&1 || {
      echo "update.sh needs curl to download the update" >&2
      exit 1
    }
    echo "checking $REPO for a newer build"
    # No -S here: curl would print its own 404 for the pre-release case, which
    # is expected and reads like a failure. Say it ourselves instead.
    if ! curl -fsL --retry 2 -o "$ZIP" "$LATEST" 2>/dev/null; then
      # `releases/latest/download` answers only for a stable release, so a
      # repo whose newest release is a pre-release 404s here.
      SRC=$(newest_url) || SRC=""
      [ -n "$SRC" ] || {
        echo "no published release of $REPO to update from" >&2
        echo "pass a local zip path instead: sh update.sh /path/to/$ASSET" >&2
        exit 1
      }
      echo "no stable release yet — downloading $SRC"
      download "$SRC" || { echo "download failed: $SRC" >&2; exit 1; }
    fi
    ;;
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
    download "$SRC" || { echo "download failed: $SRC" >&2; exit 1; }
    ;;
esac

unzip -tq "$ZIP" >/dev/null || { echo "not a valid zip: ${SRC:-$LATEST}" >&2; exit 1; }

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
