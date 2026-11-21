// Phone recording → meeting, at the logic level, with real HTTP to `wrangler dev` and the app's real decoder in
// Electron: the recordings made by phone.mjs (or an AAC file made with afconvert) are uploaded through the /rec
// routes, pulled by the app's RecordingsPuller (src/main/recordingsPull.ts) with the same HTTP calls as
// src/main/phoneRecordings.ts, decoded by src/main/audioDecode.ts, "transcribed" (a stub: the speech engine isn't
// run here), uploaded with src/main/cloudPayload.ts and read back through the MCP connector.
// Run: bash scripts/cloud-sim/run.sh pull   (after phone, which makes the recordings)
import { readFileSync, writeFileSync, existsSync, mkdtempSync, statSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, SCHEMA_SQL, makeProject, startWorker, token, scenario, summary, assert, eq } from "./lib.mjs";
import { RecordingsPuller, parseRecordingList, MeetingGoneError } from "../../src/main/recordingsPull.ts";
import { fitMeetingPayload } from "../../src/main/cloudPayload.ts";

const require = createRequire(join(REPO, "package.json"));
const ts = require("typescript");
const ELECTRON = require("electron"); // the path of the repo's Electron binary
const OUT = process.env.CLOUD_SIM_OUT || join(tmpdir(), "klara-cloud-sim-out");
const WORK = mkdtempSync(join(tmpdir(), "klara-cloud-sim-pull-"));
const T = { KLARA_TOKEN: token(), KLARA_MCP_TOKEN: token(), KLARA_REC_TOKEN: token() };

// ---------- the app's decoder, transpiled for Electron ----------
const AUDIO_DECODE_JS = join(WORK, "audioDecode.mjs");
writeFileSync(
  AUDIO_DECODE_JS,
  ts.transpileModule(readFileSync(join(REPO, "src/main/audioDecode.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText,
);

function runDecoder(cases) {
  const r = spawnSync(ELECTRON, [join(REPO, "scripts/cloud-sim/electron-decode.mjs")], {
    env: { ...process.env, AUDIO_DECODE_JS, DECODE_CASES: JSON.stringify(cases), ELECTRON_ENABLE_LOGGING: "0" },
    encoding: "utf8",
    timeout: 300_000,
  });
  const out = (r.stdout || "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  if (out.length !== cases.length) throw new Error(`electron decoder: ${r.status} ${r.stderr?.slice(-2000)}`);
  return Object.fromEntries(out.map((o) => [o.name, o]));
}

// ---------- inputs ----------
const inputs = {};
for (const [name, file, mime] of [
  ["webm", "phone-he.webm", "audio/webm;codecs=opus"],
  ["resumed", "phone-resumed.webm", "audio/webm;codecs=opus"],
  ["mp4", "phone-en.mp4", "audio/mp4"],
]) if (existsSync(join(OUT, file))) inputs[name] = { file: join(OUT, file), mime };
// An AAC .m4a, as an iPhone voice memo would be (afconvert is part of macOS).
try {
  const m4a = join(WORK, "he.m4a");
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", join(REPO, "engine/tests/audio/he.wav"), m4a]);
  inputs.aac = { file: m4a, mime: "audio/mp4" };
} catch {}

// ---------- the app's HTTP calls (src/main/phoneRecordings.ts and cloud.ts) ----------
function http(base) {
  const req = (method, path, opts = {}) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${opts.token ?? T.KLARA_TOKEN}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  return req;
}

/** A computer running Klara Wisper: its meetings, pending list and the puller wired like phoneRecordings.ts. */
function computer(base, { fail = {}, tok } = {}) {
  const req = http(base);
  const meetings = new Map(); // id -> {meta, transcript, recId}
  let pending = [];
  const failOnce = (step) => {
    if (fail[step] > 0) {
      fail[step]--;
      throw new Error(`${step} failed (simulated)`);
    }
  };
  const logs = [];
  const deps = {
    canRun: () => true,
    features: async () => {
      const r = await fetch(base + "/api/health", { redirect: "error" });
      if (!r.ok) return null;
      return (await r.json()).features ?? [];
    },
    list: async () => {
      const out = [];
      for (const status of ["ready", "processing"]) {
        const r = await req("GET", `/api/recordings?status=${status}`, { token: tok });
        if (!r.ok) throw new Error(`the Worker answered ${r.status} to the recordings list`);
        out.push(...parseRecordingList(await r.json()));
      }
      return out;
    },
    claim: async (id) => {
      failOnce("claim");
      const r = await req("POST", `/api/recordings/${encodeURIComponent(id)}/claim`, { body: "{}", token: tok });
      if (r.ok) return true;
      if (r.status === 404 || r.status === 409 || r.status === 410) return false;
      throw new Error(`the Worker answered ${r.status} to claim`);
    },
    release: async (id) => {
      const r = await req("POST", `/api/recordings/${encodeURIComponent(id)}/release`, { body: "{}", token: tok });
      if (!r.ok && r.status !== 404) throw new Error(`the Worker answered ${r.status} to release`);
    },
    download: async (id) => {
      failOnce("download");
      const r = await req("GET", `/api/recordings/${encodeURIComponent(id)}/audio`, { token: tok });
      if (!r.ok) throw new Error(`the Worker answered ${r.status} to the download`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const expected = Number(r.headers.get("x-recording-bytes") ?? NaN);
      if (Number.isFinite(expected) && expected !== bytes.byteLength) throw new Error("the download was cut off");
      return { bytes, contentType: r.headers.get("content-type") };
    },
    decode: async (rec, bytes) => {
      failOnce("decode");
      const input = join(WORK, `in-${rec.id}`);
      const out = join(WORK, `phone-${rec.id}.pcm`);
      writeFileSync(input, bytes);
      const res = runDecoder([{ name: "x", in: input, out }]).x;
      rmSync(input, { force: true });
      if (!res.ok) throw new Error(res.error);
      if (res.samples < 16000) throw new Error("the recording is shorter than a second");
      return out;
    },
    findLocal: (recordingId) => {
      for (const m of meetings.values()) if (m.recId === recordingId) return { meetingId: m.meta.id, status: m.meta.status };
      return null;
    },
    removeLocal: (id) => meetings.delete(id),
    transcribe: async (rec, pcmPath) => {
      failOnce("transcribe");
      const seconds = statSync(pcmPath).size / 32000;
      const id = `m_sim_${rec.id.slice(2, 10)}`;
      const meta = { id, title: rec.title ?? "הקלטה מהטלפון", startedAt: rec.startedAt, durationSec: Math.round(seconds), source: rec.kind === "inperson" ? "inperson" : "phone", status: "done" };
      // The speech engine isn't run in the simulation: the transcript says what was decoded.
      const transcript = `**דובר 1** [00:00]\nסימולציה: ${seconds.toFixed(1)} שניות של אודיו פוענחו מ-${rec.contentType}.\n`;
      meetings.set(id, { meta, transcript, recId: rec.id, seconds });
      return id;
    },
    upload: async (meetingId) => {
      failOnce("upload");
      const m = meetings.get(meetingId);
      if (!m) throw new MeetingGoneError(meetingId);
      const body = fitMeetingPayload({ ...m.meta, participants: [], scope: null, calendarTitle: null, transcript: m.transcript, summary: null });
      const r = await req("POST", "/api/meetings", { body: JSON.stringify(body), token: tok });
      if (!r.ok) throw new Error(`upload ${meetingId}: ${r.status}`);
    },
    remove: async (id) => {
      failOnce("remove");
      const r = await req("DELETE", `/api/recordings/${encodeURIComponent(id)}`, { token: tok });
      if (!r.ok && r.status !== 404) throw new Error(`the Worker answered ${r.status} to delete`);
    },
    cleanup: (p) => rmSync(p, { force: true }),
    loadPending: () => pending,
    savePending: (l) => (pending = l),
    log: (m) => logs.push(m),
  };
  return { puller: new RecordingsPuller(deps), meetings, pending: () => pending, logs, fail };
}

/** Uploads a file through the phone routes, in uneven parts (byte splits anywhere must join back exactly). */
async function phoneUpload(base, file, mime, { title, kind = "inperson", parts = 3 } = {}) {
  const rec = (path, init) => fetch(`${base}/rec/${T.KLARA_REC_TOKEN}${path}`, { method: "POST", ...init });
  const bytes = readFileSync(file);
  const r = await (await rec("/start", { headers: { "content-type": "application/json" }, body: JSON.stringify({ title, kind, mime, startedAt: new Date().toISOString() }) })).json();
  const cuts = [0];
  for (let i = 1; i < parts; i++) cuts.push(Math.floor((bytes.length * i) / parts) + 17 * i);
  cuts.push(bytes.length);
  for (let i = 0; i < parts; i++) {
    const res = await rec(`/chunk?id=${r.id}&seq=${i}`, { headers: { "content-type": "application/octet-stream" }, body: bytes.subarray(cuts[i], cuts[i + 1]) });
    if (!res.ok) throw new Error(`chunk ${i}: ${res.status}`);
  }
  const f = await rec(`/finish?id=${r.id}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ chunks: parts, durationSec: 30 }) });
  if (!f.ok) throw new Error(`finish ${f.status}`);
  return r.id;
}

async function recordings(base) {
  const r = await http(base)("GET", "/api/recordings");
  return (await r.json()).recordings;
}

async function mcpText(base, name, args) {
  const r = await fetch(`${base}/mcp/${T.KLARA_MCP_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await r.json()).result.content[0].text;
}

async function main() {
  console.log(`inputs: ${Object.keys(inputs).join(", ") || "none"} (run phone.mjs first for the Chrome recordings)`);

  await scenario("decoder (Electron): Chrome webm/opus, a cut-off webm, Chrome fragmented mp4, AAC m4a → 16 kHz PCM", async () => {
    const cases = Object.entries(inputs).map(([name, i]) => ({ name, in: i.file, out: join(WORK, `${name}.pcm`) }));
    assert(cases.length, "no inputs");
    const res = runDecoder(cases);
    for (const c of cases) {
      const r = res[c.name];
      assert(r.ok, `${c.name}: ${r.error}`);
      eq(r.fileBytes, r.samples * 2, `${c.name}: raw PCM written straight to the file`);
      const sec = r.samples / 16000;
      const range = { webm: [25, 40], resumed: [8, 16], mp4: [15, 25], aac: [8.5, 9.5] }[c.name];
      assert(sec >= range[0] && sec <= range[1], `${c.name}: ${sec.toFixed(2)} s`);
      console.log(`        ${c.name}: ${sec.toFixed(2)} s decoded in ${r.ms} ms`);
    }
  });

  await scenario("decoder: garbage → 'could not be decoded', a crashed page and a timeout reject (no hang), no file left", async () => {
    const big = inputs.webm?.file ?? inputs.aac?.file;
    const res = runDecoder([
      { name: "garbage", in: ":garbage:", out: join(WORK, "g.pcm") },
      { name: "timeout", in: big, out: join(WORK, "t.pcm"), timeoutMs: 1 },
      { name: "crash", in: big, out: join(WORK, "c.pcm"), crash: true }, // after the page loaded, while it decodes
    ]);
    assert(!res.garbage.ok && /could not be decoded/.test(res.garbage.error), `garbage: ${JSON.stringify(res.garbage)}`);
    assert(!res.timeout.ok && /took too long/.test(res.timeout.error), `timeout: ${JSON.stringify(res.timeout)}`);
    assert(!res.crash.ok && /decoder stopped/.test(res.crash.error), `crash: ${JSON.stringify(res.crash)}`);
    for (const k of ["garbage", "timeout", "crash"]) {
      eq(res[k].leftover, false, `${k}: no partial PCM left`);
      eq(res[k].windows, 0, `${k}: the hidden window is gone`);
    }
  });

  const dir = makeProject({ schema: readFileSync(SCHEMA_SQL, "utf8"), vars: T });
  const w = await startWorker(dir);
  const B = w.url;
  const src = inputs.webm ?? inputs.aac;
  try {
    await scenario("phone → cloud → app: pulled, decoded, transcribed, uploaded, readable in the connector, then deleted in the cloud", async () => {
      await phoneUpload(B, src.file, src.mime, { title: "פגישה בחדר הישיבות" });
      const pc = computer(B);
      const report = await pc.puller.pullOnce();
      eq(report.failed.length, 0, `failures: ${JSON.stringify(report.failed)}`);
      eq(report.imported.length, 1, "imported");
      const m = [...pc.meetings.values()][0];
      assert(m.seconds > 5, `decoded ${m.seconds} s`);
      eq((await recordings(B)).length, 0, "deleted in the cloud only after the upload");
      const found = await mcpText(B, "search_meetings", { query: "סימולציה" });
      assert(found.includes(m.meta.id), "the transcript is visible through the connector");
      const got = await mcpText(B, "get_meeting", { id: "latest" });
      assert(got.includes("פגישה בחדר הישיבות") && got.includes("in person"), "title and source");
      eq(pc.pending().length, 0, "nothing pending");
    });

    for (const step of ["claim", "download", "decode", "transcribe", "upload", "remove"]) {
      await scenario(`failure at ${step}: the recording stays in the cloud, and the next round finishes it`, async () => {
        const id = await phoneUpload(B, src.file, src.mime, { title: `נכשל ב-${step}` });
        const pc = computer(B, { fail: { [step]: 1 } });
        let r = await pc.puller.pullOnce();
        eq(r.failed.length, 1, "one failure");
        const still = (await recordings(B)).find((x) => x.id === id);
        assert(still, "kept in the cloud");
        const saved = step === "upload" || step === "remove";
        eq(still.status, saved ? "processing" : "ready", saved ? "saved here, still claimed" : "claim handed back (released)");
        eq(pc.pending().length, saved ? 1 : 0, "pending list");
        r = await pc.puller.pullOnce(); // two minutes later
        eq(r.failed.length, 0, `second round: ${JSON.stringify(r.failed)}`);
        eq((await recordings(B)).filter((x) => x.id === id).length, 0, "done and deleted");
        eq(pc.meetings.size, 1, "one meeting, not transcribed twice");
      });
    }

    await scenario("the meeting is deleted here before the cloud copy is cleaned up: the recording is deleted, not transcribed again", async () => {
      const id = await phoneUpload(B, src.file, src.mime, {});
      const pc = computer(B, { fail: { upload: 1 } });
      await pc.puller.pullOnce();
      eq(pc.pending().length, 1, "pending");
      pc.meetings.clear(); // the user deletes the meeting
      const r = await pc.puller.pullOnce();
      eq(r.cleaned.length, 1, "cleaned");
      eq((await recordings(B)).filter((x) => x.id === id).length, 0, "deleted in the cloud");
      eq(pc.meetings.size, 0, "not brought back");
    });

    await scenario("two computers pull at the same moment: one claims, the other skips; one meeting in all", async () => {
      await phoneUpload(B, src.file, src.mime, { title: "שני מחשבים" });
      const a = computer(B);
      const b = computer(B);
      const [ra, rb] = await Promise.all([a.puller.pullOnce(), b.puller.pullOnce()]);
      eq(ra.imported.length + rb.imported.length, 1, "imported once");
      eq(ra.failed.length + rb.failed.length, 0, "no failures");
      eq((await recordings(B)).length, 0, "deleted");
    });

    await scenario("a computer whose upload token is out of date (Worker redeployed elsewhere): list 401, nothing claimed or deleted", async () => {
      const id = await phoneUpload(B, src.file, src.mime, {});
      const pc = computer(B, { tok: token() });
      const r = await pc.puller.pullOnce().catch((e) => ({ thrown: e.message }));
      assert(String(r.thrown ?? "").includes("401"), `401 reported: ${JSON.stringify(r)}`);
      const still = (await recordings(B)).find((x) => x.id === id);
      eq(still?.status, "ready", "untouched");
      await http(B)("DELETE", `/api/recordings/${id}`);
    });

    await scenario("an older Worker without /release: the failed try's claim simply waits (404 tolerated)", async () => {
      const id = await phoneUpload(B, src.file, src.mime, {});
      const pc = computer(B, { fail: { decode: 1 } });
      // Simulate the old Worker: /release answers 404.
      pc.puller.deps.release = async () => {
        const r = await fetch(`${B}/api/recordings/nope/release-old`, { method: "POST", headers: { authorization: `Bearer ${T.KLARA_TOKEN}` } });
        if (!r.ok && r.status !== 404) throw new Error(String(r.status));
      };
      const r = await pc.puller.pullOnce();
      eq(r.failed.length, 1, "failed once");
      eq((await recordings(B)).find((x) => x.id === id)?.status, "processing", "claim kept until it expires");
      await http(B)("DELETE", `/api/recordings/${id}`);
    });
  } finally {
    await w.stop();
  }
  rmSync(WORK, { recursive: true, force: true });
  return summary("phone → meeting pull (wrangler dev + Electron decoder)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
