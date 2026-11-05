#!/bin/bash
# Builds the native helper into build/KlaraHelper.app, signed with the hardened runtime so other
# programs can't inject code into it (it holds the microphone / system audio permissions).
#   bash scripts/build-helper.sh          release: only `serve`, only for the Klara Wisper app
#   bash scripts/build-helper.sh debug    adds the test commands (mic-test, tap-test, …), any parent
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-release}"
cd "$ROOT/native/KlaraHelper"
swift build -c "$CONFIG"
# HELPER_OUT builds elsewhere (scripts/make-dmg.sh), leaving build/KlaraHelper.app and its permissions alone.
APP="${HELPER_OUT:-$ROOT/build/KlaraHelper.app}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp ".build/$CONFIG/KlaraHelper" "$APP/Contents/MacOS/KlaraHelper"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# A stable local certificate (scripts/make-signing-identity.sh) keeps macOS permissions across rebuilds.
SIGN="-"
security find-certificate -c "Klara Wisper Local" >/dev/null 2>&1 && SIGN="Klara Wisper Local"
codesign --force --sign "$SIGN" --identifier io.klara.wisper.helper --options runtime \
  --entitlements Resources/KlaraHelper.entitlements "$APP"
echo "built $APP ($CONFIG)"
