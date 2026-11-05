# Klara Wisper: install, build and test

The user guide in Hebrew is [INSTALL.he.md](INSTALL.he.md), the optional phone connector is set up in [CLOUDFLARE.he.md](CLOUDFLARE.he.md), and the project site is https://klara-gidash.github.io/klara-wisper/.

## 1. What it is, and why it's built this way

Klara Wisper records your calls and transcribes them in Hebrew. Recognised calls are Zoom, Google Meet, Teams, Slack huddles and Aircall, from the desktop apps or the browser, plus in-person meetings and dictation into any app. Claude can then use the calls before, during and after each meeting.

| Piece | Why |
|---|---|
| **Local transcription** (Whisper on the Mac's GPU via MLX; ivrit.ai's Hebrew turbo by default) | Calls never leave the computer, and Hebrew is far more accurate than with generic models. |
| **Native helper** (`native/KlaraHelper`, Swift; `native/KlaraHelperWin`, C#) | Holds the OS permissions: microphone, call audio, which app uses the mic, browser tabs, the `fn` key and paste. Release builds only answer to the Klara Wisper app itself. |
| **Engine** (`engine/`, Python) | VAD, transcription, speaker separation (NVIDIA Nemotron + voiceprints). It runs as a local WebSocket server, reachable only from the app. |
| **Calendar matching** | Each call takes the name and attendees of the calendar event it overlaps. Ad-hoc and in-person calls get a name, participants and scope from Claude instead. |
| **MCP server** `klara-wisper` (`engine/klara_engine/mcp_server.py`) | Lets Claude Desktop and Claude Code read transcripts, live ones included, and save notes. Transcript text is passed to Claude marked as data, never as instructions. |
| **Automatic summary** (`src/main/summarize.ts`) | After each call of 3 minutes or more, the Claude Code CLI (your Claude subscription, no API key) writes the notes. It may use only three tools: read this transcript, save notes, and set the meeting details. |
| **Skills** (`skills/`, also published as [klara-wisper-skills](https://github.com/klara-gidash/klara-wisper-skills)) | Before (prep), during (catch-up), after (summary, or a Gmail draft on request), and a daily digest. |
| **Daily digest** | A scheduled task in Claude Desktop, every evening. |
| **Cloudflare gateway** (`cloudflare/`, optional, off by default) | Your own Worker keeps a copy of the transcripts and summaries (no audio), so Claude on the phone can answer questions about your calls. |

## 2. Install (users)

### macOS (Apple Silicon, macOS 14.4+)
1. Download `Klara Wisper.dmg` from [Releases](https://github.com/klara-gidash/klara-wisper/releases/latest) and drag the app to Applications.
2. The first open is blocked because the app isn't notarized (there is no Apple Developer account). Go to System Settings → Privacy & Security → **Open Anyway**.
3. The first-run screen installs the engine (Python and its packages, in `~/Library/Application Support/Klara Wisper`, no admin rights needed) and downloads the models (about 2 GB). It also asks for the permissions.
4. Claude is connected automatically: the MCP server is added to Claude Desktop and Claude Code, and the skills are installed for Claude Code. Restart Claude Desktop once.
5. For automatic summaries: Settings → Claude → **Sign in to Claude**, once.

### Windows 10/11 x64
1. Download `Klara Wisper Setup.exe` from [Releases](https://github.com/klara-gidash/klara-wisper/releases/latest). It installs per user, with no admin rights.
2. SmartScreen warns because the installer is unsigned: **More info → Run anyway**.
3. The first run installs the engine and models the same way, into `%APPDATA%\Klara Wisper`.

> **Windows status:** the installer is built automatically on GitHub (see §3). It has **not yet been tested on a real Windows PC**. Its limits:
> - no calendar yet, so calls are named by app or tab;
> - transcription runs on the CPU (int8), so it is slower than on a Mac;
> - push-to-talk is Right Ctrl.
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
- **Actions → Build installers → Run workflow.** Set `release` to a tag such as `v0.1.0` to attach the installers to that release.
- Or push a tag (`git tag v0.1.1 && git push --tags`) to build and attach both automatically.

It uses no secrets.

## 4. How to test

### Automated (about a minute, no models loaded)
```bash
npm run typecheck                      # both TypeScript projects
npm run test:detector                  # 43 call-detection cases: Zoom, Meet, Teams, Slack, Aircall, web/desktop, blips
node --test cloudflare/test/           # 14 cases for the Cloudflare gateway (auth, upload, MCP tools, limits)
engine/.venv/bin/python -m py_compile engine/klara_engine/*.py
```
The full engine tests load the real models (several GB of memory):
```bash
cd engine && .venv/bin/pytest -s
```

### By hand: the checklist after installing or updating
1. **Starts and calendar:** the home screen shows **Today** with your events. **Tomorrow** moves one day ahead. If it shows "Connect", press it and allow the calendar.
2. **Auto-record:** join a test call in each app you use: Zoom (app), Meet (Chrome or Safari), Teams, a Slack huddle, an Aircall call. Within about 3–8 s the live panel opens and starts transcribing. In a browser this needs the Automation permission for that browser. Without it, a notification asks after 15 s.
3. **Live in Claude:** during the call, ask Claude Desktop "מה פספסתי?". It should quote what was said in the last minutes.
4. **After the call:** the transcript is saved at once, and the recorder is free for the next call. A minute or two later:
   - the call has the calendar name, or a name from Claude for an ad-hoc call;
   - a summary appears, if you're signed in to Claude, with a "Summary ready" notification.
5. **Send from Claude:** ask "תכין טיוטת מייל עם הסיכום למשתתפים". Claude creates a Gmail draft and sends only after you confirm.
6. **Model and language:** Settings → Engine shows your Mac, the language switch and the models, each marked as fitting this Mac or slow on it. Switching takes effect after the current call.
7. **Daily digest:** in Claude Desktop → Scheduled, run "סיכום יומי של השיחות" once with **Run now**, and approve its tools.
8. **Phone (optional):** after the Cloudflare setup, ask Claude in the phone app "מה היה בשיחות היום?".

### Where to look when something is off
- App log: `~/Library/Application Support/Klara Wisper/main.log` (Windows: `%APPDATA%\Klara Wisper\main.log`). It contains no transcript text.
- Recordings: `~/Documents/Klara Wisper/Meetings/YYYY/MM/<date time · source · name>/`.

## 5. Security and privacy
- Recordings and transcripts stay on the computer. Claude reads them only through the local MCP server.
- The optional Cloudflare copy contains transcripts and summaries only, never audio. The token is stored encrypted in the macOS Keychain.
- The repo holds no keys, tokens or personal data. The builds use no secrets.
