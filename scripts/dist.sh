#!/bin/bash
# Builds "Klara Wisper.app" and installs it into /Applications.
# The Python engine and the models stay in this checkout (engine/) and ~/Library/Application Support.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
# SKIP_HELPER=1 keeps the already-signed helper, so macOS keeps its permissions.
[ "${SKIP_HELPER:-}" = 1 ] || bash scripts/build-helper.sh release
mkdir -p build && printf '%s' "$ROOT/engine" > build/engine-path.txt
npx electron-vite build
npx electron-builder --config electron-builder.config.cjs --mac --arm64
APP="dist/mac-arm64/Klara Wisper.app"
# Re-sign with the stable local certificate when it exists (see scripts/make-signing-identity.sh):
# same identity on every build, so macOS keeps the app's permissions after updates.
if security find-certificate -c "Klara Wisper Local" >/dev/null 2>&1; then
  codesign --force --deep --options runtime --timestamp=none \
    --entitlements resources/entitlements.mac.plist --sign "Klara Wisper Local" "$APP"
  codesign --verify --deep --strict "$APP"
fi
# A running copy is quit the normal way first: SIGTERM, which the app turns into its usual quit
# (no osascript: "tell application … to quit" would raise an Automation permission prompt).
# Never while a call is being recorded (quitting would cut the call): a meeting whose meta.json
# says "recording" and changed in the last 15 minutes stops the update. FORCE=1 skips that check.
MAIN_BIN="/Applications/Klara Wisper.app/Contents/MacOS/Klara Wisper"
if pgrep -f "$MAIN_BIN" >/dev/null 2>&1; then
  DATA="$HOME/Library/Application Support/Klara Wisper"
  FOLDER="$(/usr/bin/plutil -extract folder raw -o - "$DATA/settings.json" 2>/dev/null || true)"
  [ -n "$FOLDER" ] || FOLDER="$HOME/Documents/Klara Wisper"
  if [ "${FORCE:-}" != 1 ] && [ -d "$FOLDER/Meetings" ] && \
     find "$FOLDER/Meetings" -name meta.json -mmin -15 -exec grep -l '"status": "recording"' {} + 2>/dev/null | grep -q .; then
    echo "Klara Wisper is recording a call right now: run this again after the call (or FORCE=1)." >&2
    exit 1
  fi
  echo "Klara Wisper is running: asking it to quit (anything being saved is finished first)..."
  pkill -TERM -f "$MAIN_BIN" || true
  for i in $(seq 1 120); do
    pgrep -f "$MAIN_BIN" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "$MAIN_BIN" >/dev/null 2>&1; then
    echo "Klara Wisper did not quit within 120 s; quit it yourself and run this again." >&2
    exit 1
  fi
  echo "Klara Wisper quit."
fi
rm -rf "/Applications/Klara Wisper.app"
cp -R "$APP" /Applications/
# Only the copy in /Applications should exist for macOS: build copies share its identity and
# would confuse Launchpad/Spotlight and the privacy permissions.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for stale in dist/mac-arm64/*.app build/KlaraHelper.app; do "$LSREG" -u "$ROOT/$stale" 2>/dev/null || true; done
rm -rf dist
touch build/.metadata_never_index
echo "installed /Applications/Klara Wisper.app"
