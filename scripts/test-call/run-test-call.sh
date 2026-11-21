#!/bin/bash
# End-to-end call test on this Mac: a fake "Zoom" app holds the microphone while Hebrew audio plays
# through the speakers, so Klara Wisper detects a Zoom call, records both sides and transcribes them.
# Usage: scripts/test-call/run-test-call.sh [seconds]   (default 150)
#
# FakeZoom is built as a real .app (bundle id us.zoom.xos.klaratest) and started with `open`, so it is
# its own app for macOS: the microphone prompt names "FakeZoom" (not Terminal/Claude) and the call
# detector sees the bundle id "us.zoom.xos…" (Zoom). Its microphone permission is removed at the end.
# Run it outside real meetings: the calendar match could attach the test call to a meeting happening now.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
BUILD="$DIR/build"
APP="$BUILD/FakeZoom.app"
SECS="${1:-150}"
LOG="$HOME/Library/Application Support/Klara Wisper/main.log"
BUNDLE_ID=us.zoom.xos.klaratest

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
echo "Building FakeZoom.app..."
xcrun swiftc -O -target arm64-apple-macos14.0 "$DIR/FakeZoom.swift" -o "$APP/Contents/MacOS/FakeZoom" -framework AVFoundation
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"

SAMPLES=()
for f in he.wav meeting4.wav conversation.wav; do
  [ -f "$ROOT/engine/tests/audio/$f" ] && SAMPLES+=("$ROOT/engine/tests/audio/$f")
done

cat <<EOF

=== Klara Wisper test call ===
1. Klara Wisper must be running, the speaker volume up.
2. macOS asks once whether "FakeZoom" may use the microphone: click Allow.
3. Klara Wisper shows the Zoom call and starts recording.
4. Hebrew audio starts once the microphone is open; it all ends by itself in about ${SECS} s.

EOF

open -n "$APP" --args "$SECS"
# Wait until FakeZoom runs and has the microphone (the prompt may take a moment to answer).
for i in $(seq 1 120); do
  pgrep -f "$APP/Contents/MacOS/FakeZoom" >/dev/null && break
  sleep 1
done
pgrep -f "$APP/Contents/MacOS/FakeZoom" >/dev/null || { echo "FakeZoom did not start" >&2; exit 1; }
sleep 10
for s in "${SAMPLES[@]}"; do
  pgrep -f "$APP/Contents/MacOS/FakeZoom" >/dev/null || break
  echo ">> playing $(basename "$s")"
  afplay "$s" || true
done
echo ">> audio done, waiting for FakeZoom to release the microphone..."
while pgrep -f "$APP/Contents/MacOS/FakeZoom" >/dev/null; do sleep 2; done
tccutil reset Microphone "$BUNDLE_ID" >/dev/null 2>&1 || true

echo
echo "=== Done. Log: ==="
grep -iE "call detected|recording|calendar event" "$LOG" 2>/dev/null | tail -15 || echo "(log not found at $LOG)"
