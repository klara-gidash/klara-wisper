# Klara Wisper: install, build and test

The user guide in Hebrew is [INSTALL.he.md](INSTALL.he.md), the optional phone connector is set up in [CLOUDFLARE.he.md](CLOUDFLARE.he.md), the Windows status is in [WINDOWS.md](../WINDOWS.md), and the project site is https://klara-gidash.github.io/klara-wisper/.

## 1. What it is, and why it's built this way

Klara Wisper records your calls and transcribes them in Hebrew, plus in-person meetings and dictation into any app. Claude can then use the calls before, during and after each meeting. It detects calls by itself:

| Where | Detected |
|---|---|
| Desktop apps (Mac) | Zoom, Teams, Slack, FaceTime, Webex, Aircall, WhatsApp, Telegram, Discord, Signal, Messenger, GoTo |
| In a browser | Google Meet (also inside Gmail and Google Chat), Zoom, Teams, Slack, Webex, GoTo, Whereby, Jitsi, Google Voice, Aircall, WhatsApp Web, Telegram Web, Discord, Messenger |
| Mac browsers whose tabs are read | Chrome, Safari, Arc, Edge, Brave, Vivaldi, Opera (Automation permission, asked per browser) |
| Mac browsers without tab reading | Firefox and Zen (no AppleScript tab access); Dia, Chromium and Orion (in the detector's table, but the helper's `BrowserTabs.swift` doesn't read them yet). A call there gets a "click to record" notification |
| Windows | The same apps minus FaceTime, by exe name or Store package family name; browser calls (Meet, Zoom, Teams, Slack, Webex, WhatsApp, Telegram, Discord, Messenger) by window title |

| Piece | Why |
|---|---|
| **Local transcription** (Whisper on the Mac's GPU via MLX; ivrit.ai's Hebrew turbo by default; CTranslate2 on Windows) | Calls never leave the computer, and Hebrew is far more accurate than with generic models. |
| **Native helper** (`native/KlaraHelper`, Swift; `native/KlaraHelperWin`, C#) | Holds the OS permissions: microphone, call audio, which app uses the mic, browser tabs, the `fn` key and paste. Release builds only answer to the Klara Wisper app itself; on the Mac the helper verifies its parent chain, the copy it re-launches included. |
| **Engine** (`engine/`, Python) | VAD, transcription, speaker separation (NVIDIA Nemotron + voiceprints). It runs as a local WebSocket server, reachable only from the app. A watchdog restarts it if it isn't ready for 5 minutes (never during a call), and the app reconnects after the computer sleeps. |
| **Call detection** (`src/main/meetings/detector.ts`) | Tables `APPS`, `BROWSERS`, `WEB`, `WEB_TITLES` and `NOT_CALLS`. Most calls start after 3 s on the mic (Aircall 5 s, Slack/Teams web tabs 8 s); chat apps (WhatsApp, Telegram, Signal, Messenger, Discord) after 10 s, because voice messages are short. An unknown app on the mic for 15 s gets a "click to record" notification unless it's on the not-a-call list (dictation, Siri, Claude, recorders), and a pending notification never blocks other calls. |
| **Calls in a row** (`src/main/meetings/calls.ts`) | Every call gets its own recording: Zoom then Zoom, Meet then Meet, Zoom then WhatsApp. The only exception is rejoining the same web meeting (same Meet code) within 2 minutes. A new call that starts while the previous one is being closed starts at once, and each finished transcript is saved immediately, so `get_transcript('latest')` reads it right away. |
| **Microphone choice** (`src/main/audio.ts`) | Opens the input the call app uses and follows it when the call app moves to a headset or AirPods. With no hint (Windows, an unknown app) and 2+ microphones, a 2 s scan runs once and the winner is remembered. A microphone picked in Settings always wins. |
| **Calendar** (EventKit, `CalendarSource.swift`) | Reads the Mac's Calendar app, all calendars. Work and personal accounts (Google Workspace, Outlook/Exchange, iCloud) are added once in System Settings → Internet Accounts; no separate Google or Microsoft sign-in. Each call takes the name and attendees of the event it overlaps. Ad-hoc and in-person calls get a name, participants and scope from Claude instead. No calendar on Windows yet. |
| **MCP server** `klara-wisper` (`engine/klara_engine/mcp_server.py`) | Lets Claude Desktop and Claude Code read transcripts, live ones included, and save notes. Transcripts and saved notes are passed to Claude marked as untrusted data, never as instructions. |
| **Automatic summary** (`src/main/summarize.ts`, Mac) | After each call of 3 minutes or more, the Claude Code CLI (your Claude subscription, no API key) writes the notes. It may use only three tools (read this transcript, save notes, set the meeting details); the MCP server is scoped to that one meeting (`KLARA_MCP_ONLY`), every other tool is denied (`--disallowedTools`), and the CLI runs with a minimal environment. One summary at a time; it waits while a call is recording. |
| **Push to Claude** (`src/main/claudePush.ts`, optional, off by default) | Settings → Integrations: off, notify, or open. After a call it opens Claude Desktop through `claude://claude.ai/new?q=…` (the link Anthropic documents in "Open Claude Desktop with a link") with a prefilled prompt; Claude shows the summary, decisions and action items, and the user goes on from there. If automatic summaries are off, the prompt asks Claude to summarize the call. |
| **Obsidian export** (`src/main/obsidian.ts`, `src/shared/notes.ts`, optional) | One note per call at `<vault>/Klara Wisper/YYYY-MM-DD HH-MM title.md`, with YAML front matter, the summary and the transcript. Updated automatically, renamed with the call, and "export all" is available. Edits made inside the note are overwritten. |
| **Transcripts** (`transcript.md`) | Starts with YAML front matter (id, title, date, source, duration, calendar event, participants, scope), so calls are easy to find in Finder or Spotlight and to use in other tools. The folder layout is unchanged. |
| **Skills** (`skills/`, also published as [klara-wisper-skills](https://github.com/klara-gidash/klara-wisper-skills)) | Before (prep), during (catch-up), after (summary, or a Gmail draft on request), and a daily digest. |
| **Daily digest** | A scheduled task in Claude Desktop, every evening. |
| **Cloudflare gateway** (`cloudflare/`, optional, off by default) | Your own Worker keeps a copy of the transcripts and summaries (no audio), so Claude on the phone can answer questions about your calls. The connector uses its own read-only MCP token, and deleting a call deletes its cloud copy too. |

## 2. Install (users)

### macOS (Apple Silicon, macOS 14.4+)
1. Download `Klara Wisper.dmg` from [Releases](https://github.com/klara-gidash/klara-wisper/releases/latest) and drag the app to Applications.
2. The first open is blocked because the app isn't notarized (there is no Apple Developer account). Go to System Settings → Privacy & Security → **Open Anyway**.
3. The first-run screen installs the engine (Python and its packages, in `~/Library/Application Support/Klara Wisper`, no admin rights needed) and downloads the models (about 2 GB). It also asks for the permissions, including Automation for every supported browser that is running.
4. Claude is connected automatically: the MCP server is added to Claude Desktop and Claude Code, and the skills are installed for Claude Code. Restart Claude Desktop once.
5. For automatic summaries: Settings → Claude → **Sign in to Claude**, once.
6. For calendar names: add your accounts (Google Workspace, Outlook/Exchange, iCloud) once in System Settings → Internet Accounts, with Calendars ticked. Klara Wisper reads whatever the Calendar app shows.

**Updating to 0.1.1:** the macOS helper was rebuilt, so macOS asks once more for the microphone, system audio, Accessibility and Input Monitoring.

### Windows 10/11 x64
1. Download `Klara Wisper Setup.exe` from [Releases](https://github.com/klara-gidash/klara-wisper/releases/latest). It installs per user, with no admin rights.
2. SmartScreen warns because the installer is unsigned: **More info → Run anyway**.
3. The first run installs the engine and models the same way, into `%APPDATA%\Klara Wisper`.

> **Windows status:** the helper compiles and the installer is built and smoke-tested on GitHub Actions (see §3 and §4). It has **not yet been tried on a real Windows PC**. Its limits:
> - no calendar yet, so calls are named by app or tab;
> - transcription runs on the CPU (int8), so it is slower than on a Mac;
> - push-to-talk is Right Ctrl;
> - automatic summaries run on the Mac only.
>
> Details: [WINDOWS.md](../WINDOWS.md).

## 3. Build from source

### On a Mac
```bash
bash scripts/setup.sh          # first time: Node + uv into ~/.local, the engine, models, the helper, the app
bash scripts/dist.sh           # rebuild and install /Applications/Klara Wisper.app
SKIP_HELPER=1 bash scripts/dist.sh   # same, but keep the signed helper, so macOS keeps its permissions
bash scripts/make-dmg.sh       # release/Klara Wisper.dmg for other people (doesn't touch the installed app)
```

### On Windows
```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-windows.ps1   # needs Node 24 and the .NET 8 SDK
```

### On GitHub, both platforms, no local setup
Use the workflow `.github/workflows/installers.yml`:
- **Actions → Build installers → Run workflow.** Set `release` to a tag such as `v0.1.1` to attach the installers to that release.
- Or push a tag (`git tag v0.1.1 && git push --tags`) to build and attach both automatically.

Each installer is smoke-tested before it is kept (§4). It uses no secrets.

## 4. How to test

### Automated (about a minute, no models loaded)
```bash
npm run typecheck                      # both TypeScript projects
npm test                               # 98 unit tests: 71 call detection, 14 calls in a row, 13 Obsidian/notes
npm run test:detector                  # only the 71 detection cases
node --test cloudflare/test/           # 15 cases for the Cloudflare gateway (auth, upload, MCP tools, limits)
engine/.venv/bin/python -m py_compile engine/klara_engine/*.py
```
`npm test` runs `node --test test/*.test.mts`: `detector.test.mts` (apps, browsers, web tabs, Windows names and titles, timing, blips, not-a-call apps), `calls.test.mts` (the call controller with fake recorder and detector) and `obsidian.test.mts` (front matter, note names, the vault path check).

The full engine tests load the real models (several GB of memory):
```bash
cd engine && .venv/bin/pytest -s
```

### CI on every push (`.github/workflows/ci.yml`)
Runs on every push and pull request to `main`, with a read-only token and no secrets:
- **checks** (Ubuntu): `npm ci --ignore-scripts`, both type checks, the detector tests, every `test/*.test.mts`, the Cloudflare Worker tests, and `py_compile` of the engine on Python 3.12.
- **engine-fast** (macOS 14): pinned, checksum-verified `uv`, `uv sync --locked`, then the engine tests that need no model (`pytest -k "echo_score or rejects"`: the echo score, and that a wrong token or a web page's Origin is refused).

### Installer smoke tests (`.github/workflows/installers.yml`)
Runs on a `v*` tag or by hand. Each build job installs and starts what it built; a failure fails the job, so nothing is attached:
- **mac** (`scripts/ci/smoke-mac.sh`): mounts the dmg, `codesign --verify --deep --strict`, checks that the Electron fuses are locked, copies the app to `/Applications`, launches it and follows `main.log` until the first-run setup (Python, packages, models) completes and the engine process starts. Transcription itself isn't tested (GitHub's macOS VMs may have no Metal GPU).
- **windows** (`scripts/ci/smoke-windows.ps1`): silent per-user install, first launch, follows `main.log` through the first-run setup until the engine process runs, then uninstalls.
- **release**: the only job with write access; it runs only when every build that ran passed its smoke test.

The smoke scripts replace the installed app and its settings, so they refuse to run outside GitHub Actions unless `KLARA_SMOKE_FORCE=1` (use a throwaway machine).

### By hand: the Mac checklist after installing or updating
1. **Permissions after the update:** macOS asks again for the microphone, system audio, Accessibility and Input Monitoring. Settings → Permissions shows all of them granted.
2. **Starts and calendar:** the home screen shows **Today** with events from every account in the Calendar app. **Tomorrow** moves one day ahead. If it shows "Connect", press it and allow the calendar.
3. **Auto-record:** join a test call in each app you use: Zoom (app), Meet (Chrome or Safari), Teams, a Slack huddle, an Aircall call. Within about 3–8 s the live panel opens and starts transcribing. In a browser this needs the Automation permission for that browser. Without it, a notification asks after 15 s.
4. **WhatsApp call:** a real WhatsApp call (desktop app, then WhatsApp Web in Chrome) starts recording about 10 s in. A 5 s voice message records nothing.
5. **Zoom → Zoom in a row:** end a Zoom call and start another one within a minute. The library shows **2 recordings**, each with its own transcript. Zoom → WhatsApp gives 2 as well. Leaving a Meet and rejoining the same code within 2 minutes gives 1.
6. **Headset switch mid-call:** start a Zoom call on the built-in mic, then pick a headset or AirPods in Zoom. `main.log` shows `mic switched to "…" (the call app moved to it)` and the transcript keeps going.
7. **Live in Claude:** during the call, ask Claude Desktop "מה פספסתי?". It should quote what was said in the last minutes.
8. **After the call:** the transcript is saved at once, and the recorder is free for the next call. Asking Claude for the latest call (`get_transcript('latest')`) returns it right away. `transcript.md` starts with the YAML front matter. A minute or two later:
   - the call has the calendar name, or a name from Claude for an ad-hoc call;
   - a summary appears, if you're signed in to Claude, with a "Summary ready" notification.
9. **Push to Claude:** Settings → Integrations → "Open in Claude after a call" → **Notify**. After a call of 3+ minutes, click the notification: Claude Desktop opens with the prompt filled in but not sent. Try **Open** (opens by itself), and auto summary off (the prompt asks to summarize the call).
10. **Obsidian export:** choose a vault folder. After a call, `<vault>/Klara Wisper/YYYY-MM-DD HH-MM title.md` appears with front matter, summary and transcript. Rename the call in the app: the note is renamed, not duplicated. **Export all calls** writes the earlier ones.
11. **Unknown app:** an app that isn't in the list holds the mic for 15 s → a "click to record" notification. While it is pending, a Zoom call still records by itself.
12. **Send from Claude:** ask "להכין טיוטת מייל עם הסיכום למשתתפים". Claude creates a Gmail draft and sends only after you confirm.
13. **Model and language:** Settings → Engine shows your Mac, the language switch and the models, each marked as fitting this Mac or slow on it. Switching takes effect after the current call.
14. **Sleep:** put the Mac to sleep for a few minutes and wake it. The engine comes back to ready without restarting the app.
15. **Daily digest:** in Claude Desktop → Scheduled, run "סיכום יומי של השיחות" once with **Run now**, and approve its tools.
16. **Phone (optional):** after the Cloudflare setup, ask Claude in the phone app "מה היה בשיחות היום?". Delete a test call in the app and check that it is gone from the phone too.

### By hand: the Windows-PC checklist
- [ ] Install `Klara Wisper Setup.exe` (SmartScreen → More info → Run anyway). The app starts without a crash, and no console windows flash up (helper, engine, setup).
- [ ] First launch: Python, packages and models install; the engine becomes ready.
- [ ] Dictation: hold Right Ctrl, speak Hebrew, release → the text is pasted in Notepad.
- [ ] Zoom desktop call → detected, both sides transcribed (mic + loopback), `audio.m4a` saved.
- [ ] Teams (new, MSIX) → detected.
- [ ] WhatsApp (Store app) call → recorded after about 10 s; a short voice message is not.
- [ ] Meet in Chrome or Edge → detected by the window title.
- [ ] Zoom → Zoom in a row → 2 recordings.
- [ ] Two microphones (laptop + USB headset): the first call runs the 2 s scan and `main.log` names the chosen mic; the next call uses it without scanning.
- [ ] After the call: speakers assigned.
- [ ] Settings → Claude → connect → Claude Desktop on Windows lists the klara-wisper tools.
- [ ] Obsidian export writes notes into a vault on a Windows path.
- [ ] `%APPDATA%\Klara Wisper\main.log` has no transcript text, call titles or Claude output.

### Where to look when something is off
- App log: `~/Library/Application Support/Klara Wisper/main.log` (Windows: `%APPDATA%\Klara Wisper\main.log`). It contains no transcript text, call titles or Claude output.
- Recordings: `~/Documents/Klara Wisper/Meetings/YYYY/MM/<date time · source · name>/`.

### Known limits
- The first 3–15 s of a call happen before it is detected, so they are not in the recording.
- Windows hasn't been tried on a real PC yet (only built and smoke-tested on GitHub Actions).
- FaceTime, Webex, Teams desktop and WhatsApp desktop haven't been tried in real calls; their detection is covered by the unit tests only.
- On the Mac, Dia, Chromium and Orion tabs aren't read by the helper, so calls there always ask first.
- The helper's parent check can't be fully pinned without an Apple Developer ID: with an ad-hoc signature the code requirement can only name the bundle identifier, not a certificate or team, so the bundle path is what ties the parent to the app.

## 5. Security and privacy
- Recordings and transcripts stay on the computer. Claude reads them only through the local MCP server.
- The macOS helper checks its whole parent chain (Klara Wisper → helper → the helper's re-launched copy) before it serves anything.
- The automatic-summary Claude can only touch the meeting it summarizes (`KLARA_MCP_ONLY` plus `--disallowedTools`) and runs with a minimal environment. Transcripts and saved notes reach Claude as untrusted data.
- The optional Cloudflare copy contains transcripts and summaries only, never audio. The upload token is stored encrypted in the macOS Keychain; the Claude connector uses a separate read-only MCP token. Deleting a call also deletes its cloud copy.
- Logs never contain call titles, transcript text or Claude output.
- CI uses least privilege: read-only tokens everywhere, and only the release job may write.
- The repo holds no keys, tokens or personal data. The builds use no secrets.
