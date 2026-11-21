# End-to-end simulations (`.github/workflows/e2e.yml`)

Manual only: Actions → **E2E simulations** → Run workflow. Builds the real installers once per OS,
then runs every scenario on its own fresh GitHub machine. Each check prints `ok: …` / `FAIL: …`, each
job writes a summary table (job page → Summary), and everything it collected (main.log,
health.json, settings, claude_desktop_config.json, wizard screenshots, transcript files) is uploaded
as an artifact `e2e-windows-<scenario>` / `e2e-mac`, pass or fail.

These scripts install, uninstall and overwrite the app's settings: they refuse to run outside GitHub
Actions unless `KLARA_SMOKE_FORCE=1` (throwaway VM only, never on a real Mac or PC).

| Job | Script | What it proves |
|---|---|---|
| W1 | `win-w1-wizard.ps1` + `wizard.cjs` | Clean silent install, no seeded settings. The wizard is walked over CDP by clicking only its big footer button (waits while disabled, screenshots each step, fails on a dead end). Then setup, health ok for app, helper, engine, models, transcribe, storage, claude, and the MCP client. |
| W2 | `win-w2-call.ps1` + `win-audio.ps1` + `play.py` | VB-Cable as the mic, Scream (if it installs) as the other side. A Google Meet event in a local .ics, a renamed ffmpeg as `zoom.exe` holding the mic. Recording starts within 90 s; the live transcript has Hebrew mic and system lines; MCP `get_transcript('live')` is Hebrew and `list_upcoming_meetings` shows "בדיקת שיחה". After the call: meta.json done, audio.m4a, calendar title, `list_meetings` shows it. |
| W3 | `win-w3-hebrew-profile.ps1` | APPDATA/LOCALAPPDATA/USERPROFILE (and the "User Shell Folders" known folders) under `C:\Users\קלרה-בדיקה`: install, setup, health incl. Claude self-test, MCP client. |
| W4 | `win-w4-upgrade.ps1` | v0.1.1 installed and set up, an MCP server held open like Claude Desktop does, then the new installer runs silently over it: re-sync, health ok, no `os error 32`. |
| M1+M2 | `mac-e2e.sh` + `wizard.cjs` | pkg install (no auto-launch), novice wizard over CDP (a permissions step that can't get past macOS prompts is reported as BLOCKED, then onboarding is marked done to test the rest), health (engine/transcribe only warn without Metal), claude_desktop_config.json entry, MCP client incl. the .ics event. |

Shared pieces: `common.ps1` (install/uninstall, log, setup and health waits, summary),
`make_ics.py` (the calendar fixture), `mcp_check.py` (a stdlib MCP stdio client that starts the
server exactly as `claude_desktop_config.json` lists it).

App hooks used (only active with `KLARA_E2E=1`): `KLARA_E2E_ICS_FILE` (calendar from a local
.ics), virtual mics count as real mics on Windows, main.log lines `call recording started <id>
folder=<path>` and `levels (30s) … lines mic=N system=M`, plus `--health-check` and
`--remote-debugging-port`.
