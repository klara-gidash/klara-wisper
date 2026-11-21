// The phone recording page (/rec/<token>) in a real Chrome driven by Playwright, against `wrangler dev`:
// a fake microphone plays a Hebrew test WAV, the network is cut mid-recording, a tab is closed mid-recording
// and resumed, Hebrew and English UI, phone viewport. The recordings are saved for pull.mjs to decode.
// Run: bash scripts/cloud-sim/run.sh phone
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { REPO, SCHEMA_SQL, makeProject, startWorker, token, scenario, summary, assert, eq } from "./lib.mjs";

const require = createRequire(join(REPO, "package.json"));
const { chromium } = require("playwright-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.CLOUD_SIM_OUT || join(tmpdir(), "klara-cloud-sim-out");
mkdirSync(OUT, { recursive: true });
const WAV = join(REPO, "engine/tests/audio/conversation.wav"); // 45 s of Hebrew conversation, 16 kHz mono

const T = { KLARA_TOKEN: token(), KLARA_MCP_TOKEN: token(), KLARA_REC_TOKEN: token() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, path) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${T.KLARA_TOKEN}` } });
  return r.headers.get("content-type")?.includes("json") ? r.json() : Buffer.from(await r.arrayBuffer());
}
const listAll = async (base) => (await api(base, "GET", "/api/recordings")).recordings;

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

function watch(page, problems) {
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
}

const cspWatch = () => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
};

async function main() {
  if (!existsSync(CHROME)) {
    console.log(`Chrome not found at ${CHROME}: set CHROME_PATH. Skipping the phone simulation.`);
    return;
  }
  const dir = makeProject({ schema: readFileSync(SCHEMA_SQL, "utf8"), vars: T });
  const w = await startWorker(dir);
  const B = w.url;
  const PAGE = `${B}/rec/${T.KLARA_REC_TOKEN}`;
  console.log(`wrangler dev at ${B}; Chrome ${CHROME}`);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`],
  });
  try {
    const he = await browser.newContext({
      locale: "he-IL", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ["microphone"],
    });
    await he.addInitScript(cspWatch);

    let first;
    await scenario("Hebrew phone page: ~32 s recording, network cut for 14 s mid-recording, IndexedDB keeps the parts, upload completes", async () => {
      const page = await he.newPage();
      const problems = [];
      watch(page, problems);
      await page.goto(PAGE);
      eq(await page.getAttribute("html", "dir"), "rtl", "RTL");
      eq(await page.textContent("h1"), "הקלטה ל-Klara Wisper", "Hebrew title");
      eq(await page.textContent("#status"), "לוחצים על הכפתור כדי להקליט", "ready text");
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(width <= 390, `no horizontal scroll on a phone (${width}px)`);
      await page.fill("#title", "פגישה מהטלפון");
      eq(await page.textContent("input[value=phone] + span"), "שיחת טלפון ברמקול", "kind label");
      await page.tap("input[value=phone]"); // the transparent radio covers its label, so a tap anywhere on it picks it
      await page.tap("#rec");
      await waitFor(async () => (await page.textContent("#status")).startsWith("מקליטים"), 10_000, "recording status");
      // The first 10-second part reaches the server.
      const rec = await waitFor(async () => (await listAll(B)).find((r) => r.status === "recording" && r.chunks >= 1), 20_000, "first chunk");
      const before = rec.chunks;
      // Cut the network for the chunk uploads.
      let aborted = 0;
      await page.route("**/chunk?**", (route) => (aborted++, route.abort("internetdisconnected")));
      await sleep(14_000);
      const during = (await listAll(B)).find((r) => r.id === rec.id).chunks;
      eq(during, before, "no chunk reached the server while offline");
      assert(aborted >= 1, "the page tried to upload while offline");
      const queued = await page.evaluate(() => new Promise((res) => {
        const q = indexedDB.open("klara-rec");
        q.onsuccess = () => { const c = q.result.transaction("chunks").objectStore("chunks").count(); c.onsuccess = () => res(c.result); };
      }));
      assert(queued >= 1, `parts wait in IndexedDB (${queued})`);
      await page.unroute("**/chunk?**");
      await sleep(6_000);
      await page.tap("#rec"); // stop at about 32 s
      await waitFor(async () => (await page.textContent("#status")).startsWith("הועלה"), 120_000, "uploaded status");
      const done = (await listAll(B)).find((r) => r.id === rec.id);
      eq(done.status, "ready", "ready");
      eq(done.kind, "phone", "kind");
      eq(done.title, "פגישה מהטלפון", "title");
      assert(done.durationSec >= 28 && done.durationSec <= 40, `duration ${done.durationSec}`);
      assert(done.chunks >= 3, `chunks ${done.chunks}`);
      assert(/^audio\/webm/.test(done.mime), `mime ${done.mime}`);
      const left = await page.evaluate(() => new Promise((res) => {
        const q = indexedDB.open("klara-rec");
        q.onsuccess = () => { const c = q.result.transaction("recs").objectStore("recs").count(); c.onsuccess = () => res(c.result); };
      }));
      eq(left, 0, "nothing left on the phone after the upload");
      const audio = await api(B, "GET", `/api/recordings/${rec.id}/audio`);
      eq(audio.length, done.bytes, "audio bytes");
      writeFileSync(join(OUT, "phone-he.webm"), audio);
      await page.screenshot({ path: join(OUT, "phone-he.png") });
      eq(JSON.stringify(await page.evaluate(() => window.__csp)), "[]", "no CSP violations");
      eq(problems.join("\n"), "", "no page errors");
      first = done;
      await page.close();
    });

    await scenario("tab closed mid-recording while offline, reopened: 'finish uploading' banner sends it", async () => {
      const page = await he.newPage();
      await page.route("**/rec/**/{start,chunk,finish}*", (route) => route.abort("internetdisconnected"));
      await page.goto(PAGE);
      await page.tap("#rec");
      await sleep(13_000); // one 10-second part saved on the phone
      await page.close({ runBeforeUnload: false }); // the tab is closed / the battery dies
      const page2 = await he.newPage();
      const problems = [];
      watch(page2, problems);
      await page2.goto(PAGE);
      await page2.waitForSelector("#pending:not([hidden])", { timeout: 10_000 });
      assert((await page2.textContent("#pendingText")).includes("1 הקלטות קודמות"), "banner text");
      await page2.click("#pendingBtn");
      await waitFor(async () => (await page2.textContent("#status")).startsWith("הועלה"), 90_000, "uploaded status");
      const ready = (await listAll(B)).filter((r) => r.status === "ready" && r.id !== first?.id);
      eq(ready.length, 1, "the cut-off recording arrived");
      assert(ready[0].chunks >= 1, "with its part(s)");
      writeFileSync(join(OUT, "phone-resumed.webm"), await api(B, "GET", `/api/recordings/${ready[0].id}/audio`));
      eq(problems.join("\n"), "", "no page errors");
      await page2.close();
    });

    await scenario("a second tab opened while the first records: no 'finish uploading' offer for the live recording", async () => {
      const a = await he.newPage();
      await a.goto(PAGE);
      await a.tap("#rec");
      await sleep(12_000); // the first part is saved
      const b = await he.newPage();
      await b.goto(PAGE);
      await sleep(1_500);
      eq(await b.isHidden("#pending"), true, "no banner for a recording another tab is making");
      await b.close();
      await a.tap("#rec");
      await waitFor(async () => (await a.textContent("#status")).startsWith("הועלה"), 60_000, "uploaded status");
      const ready = (await listAll(B)).filter((r) => r.status === "ready");
      assert(ready.every((r) => r.chunks >= 1), "every recording arrived whole");
      await a.close();
    });

    await scenario("English page, iPhone-style audio/mp4 (webm refused), uploads and is labeled", async () => {
      const en = await browser.newContext({ locale: "en-US", viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, permissions: ["microphone"] });
      await en.addInitScript(() => {
        const orig = MediaRecorder.isTypeSupported.bind(MediaRecorder);
        MediaRecorder.isTypeSupported = (t) => !/webm/.test(t) && orig(t);
      });
      const page = await en.newPage();
      await page.goto(PAGE);
      eq(await page.getAttribute("html", "dir"), "ltr", "LTR");
      eq(await page.textContent("h1"), "Record to Klara Wisper", "English title");
      const mp4 = await page.evaluate(() => MediaRecorder.isTypeSupported("audio/mp4"));
      if (!mp4) {
        console.log("        (this Chrome can't record audio/mp4; the English UI part still ran)");
        await en.close();
        return;
      }
      await page.tap("#rec");
      await sleep(21_000);
      await page.tap("#rec");
      await waitFor(async () => (await page.textContent("#status")).startsWith("Uploaded"), 60_000, "uploaded status");
      const r = (await listAll(B)).filter((x) => /^audio\/mp4/.test(x.mime));
      eq(r.length, 1, "an mp4 recording");
      assert(r[0].chunks >= 2, `chunks ${r[0].chunks}`);
      writeFileSync(join(OUT, "phone-en.mp4"), await api(B, "GET", `/api/recordings/${r[0].id}/audio`));
      await en.close();
    });

    await scenario("a wrong or old link is a plain 404 (the page isn't served)", async () => {
      const page = await he.newPage();
      const res = await page.goto(`${B}/rec/${token()}`);
      eq(res.status(), 404, "status");
      await page.close();
    });

    writeFileSync(join(OUT, "tokens.json"), JSON.stringify({ project: dir }, null, 2));
  } finally {
    await browser.close();
    await w.stop();
  }
  console.log(`recordings saved in ${OUT}`);
  return summary("phone page (Chrome + wrangler dev)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
