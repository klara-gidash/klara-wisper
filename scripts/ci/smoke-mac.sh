#!/bin/bash
# Smoke test of the macOS disk image on a CI machine (GitHub Actions macos-15, Apple Silicon):
#   1. mounts release/Klara Wisper.dmg, checks the app's signature and that its Electron fuses are
#      locked (RunAsNode disabled),
#   2. copies the app to /Applications and marks onboarding as done, so the first launch runs the
#      setup by itself (src/main/setup.ts: Python, the locked packages, the models),
#   3. starts the app binary and follows ~/Library/Application Support/Klara Wisper/main.log until
#      setup is complete and the engine process (python -m klara_engine.server) has started,
#   4. always prints main.log, then quits the app.
# GitHub's macOS VMs may have no Metal GPU for MLX, so only the engine PROCESS has to start; whether
# it can transcribe is not tested. An engine that exits is a warning here, unless its log shows a
# Python import error (a broken package set), which fails the test.
# Exit code 0 = passed. From the repo root, after scripts/make-dmg.sh: bash scripts/ci/smoke-mac.sh
# Never on your own Mac: it replaces /Applications/Klara Wisper.app and its settings, and starts a
# second copy of io.klara.wisper with its helper (macOS ties the permissions to that build). It
# refuses to run outside GitHub Actions unless KLARA_SMOKE_FORCE=1 (use a throwaway VM).
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${KLARA_SMOKE_FORCE:-}" != 1 ]; then
  echo "Refusing to run outside GitHub Actions (it replaces /Applications/Klara Wisper.app and its settings). Set KLARA_SMOKE_FORCE=1 on a throwaway VM." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DMG="$ROOT/release/Klara Wisper.dmg"
APP="/Applications/Klara Wisper.app"
BIN="$APP/Contents/MacOS/Klara Wisper"
DATA="$HOME/Library/Application Support/Klara Wisper"
LOG="$DATA/main.log"
MODELS=(whisper-ivrit-turbo nemotron-diarization ecapa) # DEFAULT_MODELS on the Mac (src/main/setup.ts)
SETUP_MINUTES="${SETUP_MINUTES:-25}"                  # Python + packages + models on a fresh machine
ENGINE_MINUTES="${ENGINE_MINUTES:-5}"                 # from the end of setup until the engine starts
SETTINGS='{"onboarded":true,"autoRecord":false,"autoSummary":false,"launchAtLogin":false,"claudeConnected":false}'
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/klara-smoke.XXXXXX")"
MNT="$WORK/mnt"
APP_PID=""
MOUNTED=""

fail() {
  echo "::error::SMOKE FAILED: $*" >&2
  exit 1
}

cleanup() {
  local code=$?
  set +e
  echo "== main.log"
  if [ -f "$LOG" ]; then cat "$LOG"; else echo "(no main.log)"; fi
  if [ "$code" -ne 0 ]; then
    echo "== app output (stdout/stderr)"
    cat "$WORK/app.out" 2>/dev/null
    echo "== data folder"
    ls -la "$DATA" "$DATA/engine" "$DATA/models" 2>/dev/null
  fi
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  sleep 3
  pkill -9 -f "$APP/Contents/" 2>/dev/null # the app, its helper and Electron's helpers
  pkill -9 -f 'klara_engine' 2>/dev/null
  [ -n "$MOUNTED" ] && hdiutil detach "$MNT" -force >/dev/null 2>&1
  [ "$code" -eq 0 ] && echo "SMOKE PASSED"
  exit "$code"
}
trap cleanup EXIT

strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# First fatal line of main.log ($1), if any. "setup failed" is the first-run setup (setup.ts);
# "helper setup failed" (index.ts, e.g. a hotkey the CI machine refuses) is not fatal.
fatal_line() {
  grep -i -E 'setup failed|uncaught' <<<"$1" | grep -v -i 'helper setup failed' | head -1
}

# 1. Mount the dmg; signature and fuses of the app inside it.
[ -f "$DMG" ] || fail "no disk image at $DMG"
mkdir -p "$MNT"
for attempt in 1 2 3 4; do # "Resource busy" happens on CI machines
  if hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$MNT" "$DMG"; then MOUNTED=1; break; fi
  [ "$attempt" = 4 ] && fail "hdiutil could not mount the disk image"
  echo "hdiutil attach failed (attempt $attempt), retrying in 10 s" >&2
  sleep 10
done
SRC="$MNT/Klara Wisper.app"
[ -d "$SRC" ] || fail "no Klara Wisper.app in the disk image"
codesign --verify --deep --strict --verbose=2 "$SRC" || fail "codesign --verify --deep --strict failed for the app in the dmg"
echo "ok: codesign --verify --deep --strict"
fuses="$(cd "$ROOT" && FORCE_COLOR=0 npx @electron/fuses read --app "$SRC" 2>&1 | strip_ansi)" \
  || fail "could not read the Electron fuses: $fuses"
echo "$fuses"
[[ "$fuses" == *"RunAsNode is Disabled"* ]] || fail "the Electron fuses are not locked (RunAsNode is not Disabled)"
echo "ok: RunAsNode is Disabled"

# 2. Install into /Applications, the way a colleague does.
if [ -w /Applications ]; then SUDO=""; else SUDO="sudo"; fi
$SUDO rm -rf "$APP"
$SUDO ditto "$SRC" "$APP"
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet || true
MOUNTED=""
[ -x "$BIN" ] || fail "no app binary at $BIN"
echo "ok: copied to $APP"

# 3. Onboarding done: the first launch installs the engine and the models by itself.
mkdir -p "$DATA"
chmod 700 "$DATA"
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.before-smoke"
printf '%s\n' "$SETTINGS" >"$DATA/settings.json"

# 4. Start the app binary and follow main.log.
echo "== starting $BIN"
"$BIN" >"$WORK/app.out" 2>&1 &
APP_PID=$!
start=$(date +%s)
saw_started=0
saw_helper=0
setup_at=0
last_report=$start
engine_note=""
while :; do
  sleep 5
  now=$(date +%s)
  elapsed=$((now - start))
  log="$(cat "$LOG" 2>/dev/null || true)"
  line="$(fatal_line "$log" || true)"; [ -z "$line" ] || fail "main.log: $line"
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    code=0
    wait "$APP_PID" || code=$?
    APP_PID=""
    fail "the app exited (exit code $code)"
  fi

  # 5. The packaged app started, and its helper answered.
  if [ "$saw_started" = 0 ] && grep -q 'started (packaged: true)' <<<"$log"; then saw_started=1; echo 'ok: "started (packaged: true)"'; fi
  if [ "$saw_helper" = 0 ] && grep -q 'helper permissions' <<<"$log"; then saw_helper=1; echo 'ok: "helper permissions" (the helper is running)'; fi
  [ "$saw_started" = 1 ] || [ "$elapsed" -le 120 ] || fail 'no "started (packaged: true)" in main.log after 2 minutes'
  [ "$saw_helper" = 1 ] || [ "$elapsed" -le 300 ] || fail 'no "helper permissions" in main.log after 5 minutes (did KlaraHelper start?)'

  # 6. Setup: the engine stamp and every model's .complete marker.
  if [ "$setup_at" = 0 ]; then
    missing=()
    [ -f "$DATA/engine/installed.json" ] || missing+=("engine/installed.json")
    for m in "${MODELS[@]}"; do [ -f "$DATA/models/$m/.complete" ] || missing+=("models/$m"); done
    if [ ${#missing[@]} -eq 0 ]; then
      setup_at=$now
      echo "ok: setup finished after $((elapsed / 60)) min $((elapsed % 60)) s"
    elif [ "$elapsed" -gt $((SETUP_MINUTES * 60)) ]; then
      fail "setup not finished after $SETUP_MINUTES minutes, still missing: ${missing[*]}"
    elif [ $((now - last_report)) -ge 60 ]; then
      echo "... $((elapsed / 60)) min, waiting for: ${missing[*]}"
      last_report=$now
    fi
    continue
  fi

  # 7. The engine process started (it may then fail to load Whisper without a GPU: not tested).
  [ "$saw_started" = 1 ] && [ "$saw_helper" = 1 ] || continue
  pids="$(pgrep -f 'klara_engine\.server' || true)"
  if [ -n "$pids" ]; then
    pid="${pids%%$'\n'*}"
    echo "ok: engine process $pid: $(ps -o command= -p "$pid" 2>/dev/null)"
    break
  fi
  if grep -q 'engine exited' <<<"$log"; then
    if grep -q -E 'ModuleNotFoundError|ImportError|SyntaxError' <<<"$log"; then
      fail "the engine exited with a Python import error (see main.log)"
    fi
    engine_note="$(grep -m1 'engine exited' <<<"$log")"
    echo "::warning::the engine process started but exited (no Metal GPU on this VM?): $engine_note"
    break
  fi
  [ $((now - setup_at)) -le $((ENGINE_MINUTES * 60)) ] \
    || fail "no python process running klara_engine.server $ENGINE_MINUTES minutes after setup finished"
done

# A crash of the app itself while the engine loads shows up within seconds: watch a little longer.
sleep 30
log="$(cat "$LOG" 2>/dev/null || true)"
line="$(fatal_line "$log" || true)"; [ -z "$line" ] || fail "main.log: $line"
kill -0 "$APP_PID" 2>/dev/null || fail "the app exited"
if [ -z "$engine_note" ] && grep -q 'engine exited' <<<"$log"; then
  grep -q -E 'ModuleNotFoundError|ImportError|SyntaxError' <<<"$log" && fail "the engine exited with a Python import error (see main.log)"
  echo "::warning::the engine process started but exited (no Metal GPU on this VM?): $(grep -m1 'engine exited' <<<"$log")"
fi
