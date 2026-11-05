# Klara Wisper on Windows: plan and status

Target: Windows 10 22H2 / Windows 11, x64. Install from a download link (`Klara Wisper Setup.exe`, per-user, no admin rights).
There is no code-signing certificate, so SmartScreen asks once (see `docs/colleagues-install.he.md`).

## What is shared, what is rewritten

| Part | Mac | Windows | Status |
|---|---|---|---|
| UI (`src/renderer`) | React | the same | shared; macOS-only bits (permission list, `fn` key) hidden on Windows |
| App logic (`src/main`): recorder, dictation, storage, search index, MCP connection, first-launch setup | Electron | the same | shared; paths, Claude config location, call-app names are per platform |
| Engine protocol (`engine/klara_engine/server.py`, `engine.py`): VAD, packing, sessions, speakers, voiceprints, MCP server | Python | the same | shared, unchanged |
| ASR (`asr.py`) | mlx-whisper, `mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx` | **`asr_ct2.py`**: faster-whisper / CTranslate2, `ivrit-ai/whisper-large-v3-turbo-ct2` (pinned + SHA-256), CPU int8 by default, CUDA with `KLARA_ASR_DEVICE=cuda` | implemented; tested on the Mac CPU through the real engine WebSocket (same Hebrew text as MLX on `he.wav`, ~6–7 s per call on an M2 CPU) |
| Diarization / voiceprints (Nemotron, ECAPA on torch CPU) | torch | the same (PyPI torch for Windows is CPU) | shared |
| Python install (`uv` + `uv.lock`) | `uv` in `Contents/MacOS` | `uv.exe` in `resources/bin` (pinned + SHA-256) | shared code in `src/main/setup.ts`; the lockfile has per-platform markers |
| Native helper (`native/KlaraHelperWin`, C#) | Core Audio, process tap, EventKit, AppleScript, CGEvent | **`native/KlaraHelperWin` (C#/.NET 8, NAudio 2.2.1)**, same JSON-over-stdio protocol | written; **not compiled yet** (no .NET SDK on the Mac); `make-windows.ps1` compiles it |
| Installer | `scripts/make-dmg.sh` | `scripts/make-windows.ps1` → NSIS (electron-builder) | written; must run on Windows (native module `better-sqlite3`) |

### The Windows helper, job by job

The app talks to the helper exactly as on the Mac: one JSON object per line on stdin/stdout, the same commands and events.

| Job | macOS | Windows |
|---|---|---|
| Microphone | Core Audio IOProc | WASAPI capture (NAudio `WasapiCapture`), resampled to 16 kHz mono Int16, 50 ms chunks |
| Call audio (other side) | Core Audio process tap | WASAPI **loopback** of the default output device (`WasapiLoopbackCapture`); follows the default device when it changes |
| Who uses the microphone (call detection) | `kAudioHardwarePropertyProcessObjectList` | Windows' own record of microphone use: `HKCU\…\CapabilityAccessManager\ConsentStore\microphone` (`LastUsedTimeStop == 0` = in use now; the same source as the taskbar mic icon) |
| Browser tab (Meet / Teams / Zoom web) | AppleScript tab URLs | window titles of the browser (EnumWindows): the active tab's title, e.g. "Meet – abc-defg-hij". The app matches titles on Windows |
| Push-to-talk key | listen-only CGEvent tap (`fn`) | low-level keyboard hook (`WH_KEYBOARD_LL`); no `fn` on Windows → Right Ctrl by default (Right Alt also offered) |
| Paste | clipboard + ⌘V | clipboard + `SendInput` Ctrl+V, previous clipboard text restored |
| Front app (for the dictation log) | NSWorkspace | `GetForegroundWindow` → process name |
| Audio file (`audio.m4a`) | AVAudioFile AAC | Media Foundation AAC encoder (`MediaFoundationEncoder.EncodeToAac`) |
| Calendar | EventKit | not available yet (status `unsupported`); recordings are named by app/tab |
| Permissions | TCC | only the microphone privacy switch (`ms-settings:privacy-microphone`) |
| "Only serve the app" | code-signature check of the parent | parent process must be `Klara Wisper.exe` two folders up from the helper |

## Order of work

1. ✅ Engine: CTranslate2 ASR with the same `Transcript` result (`asr_common.py` holds what both backends share); platform markers in `pyproject.toml`; lock regenerated: 6 Windows-only packages added, no existing pin changed. Tested on the Mac CPU.
2. ✅ Electron: Windows paths, helper path, Claude Desktop config path, call apps by `.exe` / Store package name, meeting tabs by window title, Right Ctrl default, permission list, window buttons. Typechecks; the call detector was unit-checked with Windows inputs.
3. ✍️ Windows helper (C#): written against NAudio 2.2.1 and Win32, **not compiled or run yet**.
4. ✍️ Build: `electron-builder.config.cjs` (`win` + `nsis`), `scripts/make-windows.ps1` (pinned uv.exe, helper, NSIS). Not run yet.
5. ⏳ On a Windows PC: build, fix what the compiler finds, install, and go through the checklist below. Not possible from the Mac.

## Test checklist on a Windows PC

- [ ] `powershell -ExecutionPolicy Bypass -File scripts\make-windows.ps1` → `release\Klara Wisper Setup.exe`
- [ ] Install, SmartScreen → "More info" → "Run anyway"; first launch shows the setup step; Python + packages + model download finish
- [ ] Dictation: hold Right Ctrl, speak Hebrew, release → text pasted in Notepad
- [ ] Zoom desktop call → detected, both sides transcribed (mic + loopback), `audio.m4a` saved
- [ ] Meet in Chrome / Edge → detected by the tab title
- [ ] Teams (new, MSIX) → detected (packaged-app entry in the consent store)
- [ ] After the call: speakers assigned
- [ ] Settings → Claude → connect → Claude Desktop on Windows lists the tools

## Known limits on Windows (first version)

- Loopback records everything the PC plays, not only the call app (no per-process capture like the Mac tap; Windows 10 2004+ has process loopback, a possible later step).
- No calendar names. Outlook/Graph would need an account connection.
- CPU transcription is slower than MLX on an M-series Mac; a PC with an NVIDIA GPU can use CUDA (`KLARA_ASR_DEVICE=cuda`, needs the CUDA 12 runtime DLLs).
