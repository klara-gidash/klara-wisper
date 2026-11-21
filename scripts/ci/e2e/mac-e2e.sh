#!/bin/bash
# M1+M2 on macOS (GitHub Actions macos-15): pkg install -> novice wizard over CDP -> setup -> health
# -> Claude Desktop config -> MCP client (tools, the calendar event from a local .ics, list_meetings).
#   bash scripts/ci/e2e/mac-e2e.sh "<path>/Klara Wisper.pkg"
# env: PW_DIR (playwright-core install folder), E2E_OUT (artifact folder)
# macOS permission prompts can't be clicked on CI: if the wizard stops on the permissions step it is
# reported as BLOCKED (a warning), onboarding is then marked done by hand and the rest still runs.
# GitHub's macOS VMs may have no Metal GPU: engine/transcribe "warn"/"fail" is recorded, not fatal.
set -uo pipefail

if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${KLARA_SMOKE_FORCE:-}" != 1 ]; then
  echo "Refusing to run outside GitHub Actions (it replaces /Applications/Klara Wisper.app)." >&2
  exit 2
fi

E2E="$(cd "$(dirname "$0")" && pwd)"
PKG="${1:?usage: mac-e2e.sh <Klara Wisper.pkg>}"
OUT="${E2E_OUT:-$PWD/e2e-out}"
APP="/Applications/Klara Wisper.app"
BIN="$APP/Contents/MacOS/Klara Wisper"
DATA="$HOME/Library/Application Support/Klara Wisper"
LOG="$DATA/main.log"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
MODELS=(whisper-ivrit-turbo nemotron-diarization ecapa)
TITLE='בדיקת שיחה'
APP_PID=""
FAILED=0
ROWS=()
mkdir -p "$OUT"

row() { ROWS+=("| $1 | $2 | ${3//|//} |"); }
pass() { echo "ok: $1 ${2:-}"; row "$1" ok "${2:-}"; }
warn() { echo "::warning::$1 ${2:-}"; row "$1" warn "${2:-}"; }
fail() { echo "FAIL: $1 ${2:-}"; echo "::error::$1 ${2:-}"; row "$1" FAIL "${2:-}"; FAILED=1; }
die() { fail "$@"; exit 1; }

summary() {
  {
    echo "### M1+M2 macOS pkg + wizard + MCP"
    echo
    echo "| Check | Result | Detail |"
    echo "|---|---|---|"
    printf '%s\n' "${ROWS[@]}"
  } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

cleanup() {
  set +e
  cp -f "$LOG" "$DATA/health.json" "$DATA/settings.json" "$DATA/upcoming.json" "$CLAUDE_CFG" "$OUT/" 2>/dev/null
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  sleep 3
  pkill -9 -f "$APP/Contents/" 2>/dev/null
  pkill -9 -f klara_engine 2>/dev/null
  summary
  [ "$FAILED" = 0 ] && echo "E2E PASSED" || echo "E2E FAILED"
  exit "$FAILED"
}
trap cleanup EXIT

fatal_line() { grep -i -E 'setup failed|uncaught' "$LOG" 2>/dev/null | grep -v -i 'helper setup failed' | head -1; }

launch() {
  KLARA_E2E=1 KLARA_E2E_ICS_FILE="$OUT/calendar.ics" "$BIN" "$@" >>"$OUT/app-output.txt" 2>&1 &
  APP_PID=$!
  pass "app started" "pid $APP_PID $*"
}

stop_app() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  sleep 5
  pkill -9 -f "$APP/Contents/" 2>/dev/null
  APP_PID=""
}

health_status() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next((i["status"]+" "+str(i.get("code") or "")+" "+str(i.get("detail") or "") for i in d["items"] if i["id"]==sys.argv[2]), "missing"))' "$DATA/health.json" "$1" 2>/dev/null || echo missing; }

# 1. Install like a colleague, but don't let postinstall open the app.
[ -f "$PKG" ] || die "pkg present" "$PKG"
sudo rm -rf "$APP"
touch /tmp/klara-wisper-no-launch
sudo installer -pkg "$PKG" -target / || die "pkg install" "installer failed"
rm -f /tmp/klara-wisper-no-launch
[ -x "$BIN" ] || die "pkg install" "no $BIN"
pass "pkg install" "$(pkgutil --pkg-info io.klara.wisper.app 2>/dev/null | grep version)"
[ -f "$DATA/settings.json" ] && die "clean machine" "settings.json already exists"

# 2. Claude Desktop "installed", calendar fixture.
mkdir -p "$(dirname "$CLAUDE_CFG")"
python3 "$E2E/make_ics.py" "$OUT/calendar.ics" || die "calendar .ics"

# 3. Novice wizard over CDP.
launch --remote-debugging-port=9222 --health-check
node "$E2E/wizard.cjs" "$OUT/wizard" 2>&1 | tee "$OUT/wizard.txt"
wcode=${PIPESTATUS[0]}
case "$wcode" in
  0) pass "novice wizard reached the end" "$(ls "$OUT/wizard"/*.png 2>/dev/null | wc -l | tr -d ' ') screenshots" ;;
  3) warn "novice wizard BLOCKED on permissions" "macOS prompts can't be clicked on CI; onboarding marked done by hand to test the rest"
     ;;
  *) fail "novice wizard reached the end" "exit $wcode (see wizard.txt and screenshots)" ;;
esac
if [ "$wcode" != 0 ]; then
  stop_app
  python3 - "$DATA/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s.update(onboarded=True, claudeConnected=True, autoSummary=False, launchAtLogin=False)
json.dump(s, open(p, "w"))
PY
  rm -f "$DATA/health.json"
  launch --health-check
fi

# 4. Setup, then health.
start=$(date +%s)
while :; do
  missing=()
  [ -f "$DATA/engine/installed.json" ] || missing+=(engine)
  for m in "${MODELS[@]}"; do [ -f "$DATA/models/$m/.complete" ] || missing+=("$m"); done
  [ ${#missing[@]} -eq 0 ] && break
  line="$(fatal_line)"; [ -z "$line" ] || die "main.log has no fatal line" "$line"
  kill -0 "$APP_PID" 2>/dev/null || die "app keeps running" "exited"
  [ $(( $(date +%s) - start )) -gt 2100 ] && die "setup finished" "still missing ${missing[*]} after 35 min"
  sleep 10
done
pass "setup finished" "$(( ($(date +%s) - start) / 60 )) min"

for _ in $(seq 1 150); do # up to 25 min for health.json with app+claude ok
  if [ -f "$DATA/health.json" ] && [[ "$(health_status app)" == ok* ]] && [[ "$(health_status claude)" == ok* ]]; then break; fi
  sleep 10
done
[ -f "$DATA/health.json" ] || die "health.json" "none after 25 min"
cat "$DATA/health.json"
for item in app helper models storage claude; do
  s="$(health_status "$item")"
  if [[ "$s" == ok* ]]; then pass "health $item" "$s"; else fail "health $item" "$s"; fi
done
for item in engine transcribe microphone permissions; do
  s="$(health_status "$item")"
  if [[ "$s" == ok* ]]; then pass "health $item" "$s"; else warn "health $item (no Metal / no TCC on CI)" "$s"; fi
done

# 5. Claude Desktop config and the MCP client.
if grep -q '"klara-wisper"' "$CLAUDE_CFG" 2>/dev/null && grep -q 'klara_engine.mcp_server' "$CLAUDE_CFG"; then
  pass "claude_desktop_config.json has klara-wisper"
else
  fail "claude_desktop_config.json has klara-wisper" "$(cat "$CLAUDE_CFG" 2>/dev/null || echo missing)"
fi
# upcoming.json is written when the app reads the calendar: give it a minute.
for _ in $(seq 1 12); do [ -f "$DATA/upcoming.json" ] && grep -q "$TITLE" "$DATA/upcoming.json" && break; sleep 10; done
if python3 "$E2E/mcp_check.py" --config "$CLAUDE_CFG" --upcoming "$TITLE" 2>&1 | tee "$OUT/mcp-check.txt"; [ "${PIPESTATUS[0]}" = 0 ]; then
  pass "MCP client (tools/list, list_upcoming_meetings has the event, list_meetings)"
else
  fail "MCP client" "see mcp-check.txt"
fi
line="$(fatal_line)"; [ -z "$line" ] && pass "main.log clean" || fail "main.log has no fatal line" "$line"
