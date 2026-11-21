// Electron main script: runs the app's real decoder (src/main/audioDecode.ts, transpiled by pull.mjs to
// AUDIO_DECODE_JS) on the cases in DECODE_CASES (JSON: [{in, out, timeoutMs?, crash?}]) and prints one JSON
// line per case. Started by pull.mjs with the repo's own Electron binary; never touches the app's data.
import { app, BrowserWindow } from "electron";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

app.setPath("userData", mkdtempSync(join(tmpdir(), "klara-cloud-sim-electron-")));
app.on("window-all-closed", () => {}); // don't quit between cases

async function run() {
  app.dock?.hide();
  const { decodeToPcmFile } = await import(pathToFileURL(process.env.AUDIO_DECODE_JS).href);
  const cases = JSON.parse(process.env.DECODE_CASES || "[]");
  for (const c of cases) {
    const t0 = Date.now();
    let crashTimer;
    let onCreated;
    if (c.crash) {
      // Kill the decoder page once it has loaded and the decoder is feeding it (what an out-of-memory renderer
      // looks like): the decode must reject, not wait forever.
      onCreated = (_e, wc) =>
        wc.once("did-finish-load", () => {
          crashTimer = setTimeout(() => !wc.isDestroyed() && wc.forcefullyCrashRenderer(), 5);
        });
      app.once("web-contents-created", onCreated);
    }
    try {
      const bytes = c.in === ":garbage:" ? new Uint8Array(200_000).fill(7) : new Uint8Array(readFileSync(c.in));
      const samples = await decodeToPcmFile(bytes, c.out, { timeoutMs: c.timeoutMs });
      console.log(JSON.stringify({ name: c.name, ok: true, samples, fileBytes: existsSync(c.out) ? statSync(c.out).size : -1, ms: Date.now() - t0 }));
    } catch (err) {
      console.log(JSON.stringify({ name: c.name, ok: false, error: String(err.message), leftover: existsSync(c.out), windows: BrowserWindow.getAllWindows().length, ms: Date.now() - t0 }));
    } finally {
      clearTimeout(crashTimer);
    }
  }
}

// Not a top-level await: an ES module main that awaits app.whenReady() at the top never gets 'ready'.
app.whenReady().then(run).then(
  () => app.exit(0),
  (err) => {
    console.error(err);
    app.exit(1);
  },
);
