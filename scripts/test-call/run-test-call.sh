#!/bin/bash
# End-to-end call test: a fake "Zoom" holds the mic while Hebrew audio plays through the speakers.
# Usage: scripts/test-call/run-test-call.sh [seconds]   (default 150)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
BUILD="$DIR/build"
SECS="${1:-150}"
LOG="$HOME/Library/Application Support/Klara Wisper/main.log"

mkdir -p "$BUILD"
echo "Building FakeZoom..."
xcrun swiftc -O "$DIR/FakeZoom.swift" -o "$BUILD/FakeZoom" \
  -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist"
codesign --force --sign - --identifier us.zoom.xos.klaratest "$BUILD/FakeZoom"

SAMPLES=()
for f in he.wav meeting4.wav conversation.wav; do
  [ -f "$ROOT/engine/tests/audio/$f" ] && SAMPLES+=("$ROOT/engine/tests/audio/$f")
done

cat <<EOF

=== Klara Wisper test call ===
1. Make sure Klara Wisper is running and the speaker volume is up.
2. If macOS asks for microphone access (for Terminal/FakeZoom), click Allow.
3. Klara Wisper should show "Zoom call detected" and start recording.
4. Hebrew audio starts in 8 s. Do not quit this window; it ends by itself in ~${SECS} s.

EOF

"$BUILD/FakeZoom" "$SECS" &
FZ=$!
trap 'kill $FZ 2>/dev/null || true' INT TERM

sleep 8
for s in "${SAMPLES[@]}"; do
  kill -0 $FZ 2>/dev/null || break
  echo ">> playing $(basename "$s")"
  afplay "$s" || true
done
echo ">> audio done, waiting for FakeZoom to release the mic..."
wait $FZ || true

cat <<EOF

=== Done. Where to look ===
- In the app: a new meeting (Zoom) with a Hebrew transcript.
- Log: grep -iE "call detected|recording" "$LOG" | tail -20
EOF
grep -iE "call detected|recording" "$LOG" 2>/dev/null | tail -20 || echo "(log not found at $LOG)"
