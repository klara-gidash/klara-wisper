# Klara Wisper on Windows: plan and status

Target: Windows 10 22H2 / Windows 11, x64. Install from a download link (`Klara Wisper Setup.exe`, per-user, no admin rights).
There is no code-signing certificate, so SmartScreen asks once (see `docs/colleagues-install.he.md`).

**Status (v0.1.1):** the Windows helper compiles and the installer builds on GitHub Actions (CI run 42072567985). `installers.yml` also smoke-tests the installer on `windows-latest`: silent install, first-run setup, engine start, uninstall. The startup crash and the console windows are fixed, and the Windows names of the call apps were added. **It has not been tried on a real Windows PC yet.**

## What is shared, what is rewritten

| Part | Mac | Windows | Status |
|---|---|---|---|
| UI (`src/renderer`) | React | the same | shared; macOS-only bits (permission list, `fn` key) hidden on Windows |
| App logic (`src/main`): recorder, calls in a row, dictation, storage, search index, MCP connection, first-launch setup, Obsidian export, push to Claude | Electron | the same | shared; paths, Claude config location, call-app names are per platform |
| Engine protocol (`engine/klara_engine/server.py`, `engine.py`): VAD, packing, sessions, speakers, voiceprints, MCP server | Python | the same | shared, unchanged |
| ASR (`asr.py`) | mlx-whisper, `mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx` | **`asr_ct2.py`**: faster-whisper / CTranslate2, `ivrit-ai/whisper-large-v3-turbo-ct2` (pinned + SHA-256), CPU int8 by default, CUDA with `KLARA_ASR_DEVICE=cuda` | implemented; tested on the Mac CPU through the real engine WebSocket (same Hebrew text as MLX on `he.wav`, ~6–7 s per call on an M2 CPU) |
| Diarization / voiceprints (Nemotron, ECAPA on torch CPU) | torch | the same (PyPI torch for Windows is CPU) | shared |
| Python install (`uv` + `uv.lock`) | `uv` in `Contents/MacOS` | `uv.exe` in `resources/bin` (pinned + SHA-256) | shared code in `src/main/setup.ts`; the lockfile has per-platform markers |
| Native helper (`native/KlaraHelperWin`, C#) | Core Audio, process tap, EventKit, AppleScript, CGEvent | **`native/KlaraHelperWin` (C#/.NET 8, NAudio 2.2.1)**, same JSON-over-stdio protocol | **compiles** on GitHub Actions (`windows-latest`, .NET 8 SDK, via `make-windows.ps1`); not run on a real PC |
| Installer | `scripts/make-dmg.sh` | `scripts/make-windows.ps1` → NSIS (electron-builder) | **builds** on GitHub Actions (`installers.yml`, CI run 42072567985) and is smoke-tested there (`scripts/ci/smoke-windows.ps1`) |

### The Windows helper, job by job

The app talks to the helper exactly as on the Mac: one JSON object per line on stdin/stdout, the same commands and events.

| Job | macOS | Windows |
|---|---|---|
| Microphone | Core Audio IOProc | WASAPI capture (NAudio `WasapiCapture`), resampled to 16 kHz mono Int16, 50 ms chunks |
| Which microphone | the input the call app uses (from the helper), followed when it changes | no per-app input hint: with 2+ microphones, a 2 s scan runs once at the first call and the winner is remembered (`src/main/audio.ts`); a microphone picked in Settings always wins |
| Call audio (other side) | Core Audio process tap | WASAPI **loopback** of the default output device (`WasapiLoopbackCapture`); follows the default device when it changes |
| Who uses the microphone (call detection) | `kAudioHardwarePropertyProcessObjectList` | Windows' own record of microphone use: `HKCU\…\CapabilityAccessManager\ConsentStore\microphone` (`LastUsedTimeStop == 0` = in use now; the same source as the taskbar mic icon) |
| Browser tab (Meet / Teams / Zoom web…) | AppleScript tab URLs | window titles of the browser (EnumWindows): the active tab's title, e.g. "Meet – abc-defg-hij". The app matches titles on Windows |
| Push-to-talk key | listen-only CGEvent tap (`fn`) | low-level keyboard hook (`WH_KEYBOARD_LL`); no `fn` on Windows → Right Ctrl by default (Right Alt also offered) |
| Paste | clipboard + ⌘V | clipboard + `SendInput` Ctrl+V, previous clipboard text restored |
| Front app (for the dictation log) | NSWorkspace | `GetForegroundWindow` → process name |
| Audio file (`audio.m4a`) | AVAudioFile AAC | Media Foundation AAC encoder (`MediaFoundationEncoder.EncodeToAac`) |
| Calendar | EventKit | not available yet (status `unsupported`); recordings are named by app/tab |
| Permissions | TCC | only the microphone privacy switch (`ms-settings:privacy-microphone`) |
| "Only serve the app" | code-signature check of the parent chain | parent process must be `Klara Wisper.exe` two folders up from the helper |

### Call apps on Windows (`src/main/meetings/detector.ts`)

The helper reports the executable name (lower case) or the Store package family name; the detector matches it by prefix.

| App | Names matched |
|---|---|
| Zoom | `zoom.exe` |
| Microsoft Teams | `ms-teams.exe`, `msteams_…` (Store/MSIX), `teams.exe` (classic) |
| Slack | `slack.exe`, `91750d7e.slack_…` (Store) |
| Webex | `webex.exe`, `ciscocollabhost.exe` |
| Aircall | `aircall…` |
| WhatsApp | `5319275a.whatsappdesktop…` (Store), `whatsapp.exe`, `whatsapp.root.exe` |
| Telegram | `telegrammessengerllp.telegramdesktop…` (Store), `telegram.exe` |
| Discord | `discord.exe` |
| Signal | `signal.exe` |
| Messenger | `facebook.317180b0bb486…` (Store), `messenger.exe` |
| GoTo | `goto.exe`, `g2mcomm.exe` |
| Browsers | `chrome.exe`, `msedge.exe`, `brave.exe`, `firefox.exe`, `vivaldi.exe`, `opera.exe`, `arc.exe`, `zen.exe`; the call is recognised by the window title: Meet, Teams, Zoom, Slack huddle, WhatsApp, Discord, Telegram, Messenger, Webex |
| Not calls (never announced) | `searchhost.exe`, Cortana, Sound Recorder, `claude.exe`, ChatGPT, OBS, Krisp, Voicemod, `audiodg.exe` |

Timing is the same as on the Mac: most calls after 3 s on the mic, chat apps (WhatsApp, Telegram, Signal, Messenger, Discord) after 10 s, an unknown app after 15 s with a "click to record" notification. These cases are covered by the unit tests (`test/detector.test.mts`, "Windows: …").

### Fixed in 0.1.1

- **Startup crash:** `app.setActivationPolicy` exists only on macOS; `keepInDock()` in `src/main/windows.ts` now returns early on other platforms.
- **Console windows:** the helper, the engine and the setup steps are started with `windowsHide: true`, so no console window flashes up.
- **Call-app names:** the Windows exe and Store names above were added, including WhatsApp, Telegram, Discord, Signal, Messenger and GoTo.
- **Library watcher:** if watching the recordings folder fails or stops, it retries after 5 s.

## Order of work

1. ✅ Engine: CTranslate2 ASR with the same `Transcript` result (`asr_common.py` holds what both backends share); platform markers in `pyproject.toml`; lock regenerated: 6 Windows-only packages added, no existing pin changed. Tested on the Mac CPU.
2. ✅ Electron: Windows paths, helper path, Claude Desktop config path, call apps by `.exe` / Store package name, meeting tabs by window title, Right Ctrl default, permission list, window buttons. Typechecks; the call detector is unit-tested with Windows inputs.
3. ✅ Windows helper (C#): compiles on GitHub Actions (CI run 42072567985). Not run on a real PC.
4. ✅ Build: `electron-builder.config.cjs` (`win` + `nsis`), `scripts/make-windows.ps1` (pinned uv.exe, helper, NSIS). The installer builds on GitHub Actions and is smoke-tested there.
5. ⏳ On a real Windows PC: install, and go through the checklist below. Not possible from the Mac.

## Test checklist on a Windows PC

- [ ] Get `Klara Wisper Setup.exe` from the release (or `powershell -ExecutionPolicy Bypass -File scripts\make-windows.ps1` → `release\Klara Wisper Setup.exe`)
- [ ] Install, SmartScreen → "More info" → "Run anyway"; the app starts without a crash, and no console windows flash up
- [ ] First launch shows the setup step; Python + packages + model download finish
- [ ] Dictation: hold Right Ctrl, speak Hebrew, release → text pasted in Notepad
- [ ] Zoom desktop call → detected, both sides transcribed (mic + loopback), `audio.m4a` saved
- [ ] Zoom → Zoom in a row → 2 recordings
- [ ] Meet in Chrome / Edge → detected by the tab title
- [ ] Teams (new, MSIX) → detected (packaged-app entry in the consent store)
- [ ] WhatsApp (Store app) call → recorded after about 10 s; a short voice message is not
- [ ] Two microphones: the first call runs the 2 s scan, `main.log` names the chosen mic, the next call uses it
- [ ] After the call: speakers assigned
- [ ] Settings → Claude → connect → Claude Desktop on Windows lists the tools
- [ ] Obsidian export writes notes into a vault on a Windows path

## Known limits on Windows (first version)

- Not tried on a real PC yet: the helper and the installer have only been built and smoke-tested on GitHub Actions.
- Loopback records everything the PC plays, not only the call app (no per-process capture like the Mac tap; Windows 10 2004+ has process loopback, a possible later step).
- No calendar names. Outlook/Graph would need an account connection.
- Automatic summaries run on the Mac only for now (`src/main/summarize.ts`). Push to Claude on Windows therefore only fires when "automatic summary" is switched off in Settings.
- Browser calls are recognised by the window title of the active tab only, and only for the sites listed above.
- CPU transcription is slower than MLX on an M-series Mac; a PC with an NVIDIA GPU can use CUDA (`KLARA_ASR_DEVICE=cuda`, needs the CUDA 12 runtime DLLs).
