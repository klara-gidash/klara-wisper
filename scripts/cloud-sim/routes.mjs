// Every Worker route against the real runtime: `wrangler dev` (workerd) with a local D1.
// Run: bash scripts/cloud-sim/run.sh routes   (or node scripts/cloud-sim/routes.mjs with CLOUD_SIM_DEPS set)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { REPO, SCHEMA_SQL, makeProject, startWorker, token, scenario, summary, assert, eq, applySql } from "./lib.mjs";

const T = { KLARA_TOKEN: token(), KLARA_MCP_TOKEN: token(), KLARA_REC_TOKEN: token() };
const schema = readFileSync(SCHEMA_SQL, "utf8");

async function api(base, method, path, { body, bearer = T.KLARA_TOKEN, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    h["content-type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    h["content-type"] = "application/json";
  }
  const r = await fetch(base + path, { method, headers: h, body: payload });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, data };
}

let rpcId = 0;
async function mcp(base, method, params, tok = T.KLARA_MCP_TOKEN) {
  const r = await fetch(`${base}/mcp/${tok}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: r.status, data: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
}
const toolText = async (base, name, args) => {
  const r = await mcp(base, "tools/call", { name, arguments: args });
  eq(r.status, 200, `${name} status`);
  assert(!r.data.error, `${name}: ${JSON.stringify(r.data.error)}`);
  return { text: r.data.result.content[0].text, isError: !!r.data.result.isError };
};

const meeting = (over = {}) => ({
  id: "m_" + randomBytes(6).toString("hex"),
  title: "פגישת תקציב עם דוד",
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  durationSec: 1834.4,
  source: "zoom",
  participants: ["דוד כהן", "Sarah"],
  scope: "תקציב שיווק לרבעון הבא",
  calendarTitle: "Budget sync",
  transcript: "**אני** [00:01]\nשלום לכולם, נתחיל בתקציב השיווק.\n\n**משתתף 1** [00:15]\nבתקציב של הרבעון הבא אנחנו צריכים להוסיף קמפיין.\n",
  summary: "## תקציר\nסוכם להגדיל את התקציב ב-10%.\n",
  ...over,
});

const rec = (base, path, opts = {}) => api(base, "POST", `/rec/${T.KLARA_REC_TOKEN}${path}`, { bearer: null, ...opts });

async function main() {
  const dir = makeProject({ schema, vars: { ...T, KLARA_REC_QUOTA_MB: "40" } });
  const w = await startWorker(dir);
  const B = w.url;
  console.log(`wrangler dev at ${B} (project ${dir})`);

  try {
    await scenario("health: no auth, features, security headers, no CORS", async () => {
      const r = await api(B, "GET", "/api/health", { bearer: null });
      eq(r.status, 200, "status");
      eq(r.data.ok, true, "ok");
      assert(r.data.features.includes("recordings"), "recordings feature");
      eq(r.headers.get("x-content-type-options"), "nosniff", "nosniff");
      eq(r.headers.get("access-control-allow-origin"), null, "no CORS");
    });

    const m1 = meeting();
    await scenario("meetings: upload Hebrew meeting, upsert again, validation 400", async () => {
      let r = await api(B, "POST", "/api/meetings", { body: m1 });
      eq(r.status, 200, "upload");
      r = await api(B, "POST", "/api/meetings", { body: { ...m1, title: m1.title + " (עודכן)" } });
      eq(r.status, 200, "upsert");
      r = await api(B, "POST", "/api/meetings", { body: { ...m1, id: "bad id!" } });
      eq(r.status, 400, "bad id");
      r = await api(B, "POST", "/api/meetings", { body: "{not json" });
      eq(r.status, 400, "bad json");
    });

    await scenario("token separation: MCP and phone tokens are refused on /api, wrong tokens 404 on /mcp and /rec", async () => {
      for (const t of [T.KLARA_MCP_TOKEN, T.KLARA_REC_TOKEN, "x".repeat(64), ""]) {
        eq((await api(B, "POST", "/api/meetings", { body: m1, bearer: t || null })).status, 401, "upload with other token");
        eq((await api(B, "GET", "/api/recordings", { bearer: t || null })).status, 401, "recordings with other token");
      }
      for (const t of [T.KLARA_TOKEN, T.KLARA_REC_TOKEN]) eq((await mcp(B, "initialize", {}, t)).status, 404, "mcp with other token");
      for (const t of [T.KLARA_TOKEN, T.KLARA_MCP_TOKEN]) eq((await api(B, "GET", `/rec/${t}`, { bearer: null })).status, 404, "rec with other token");
      // A token with a percent-encoded character still matches only itself.
      eq((await api(B, "GET", `/rec/${T.KLARA_REC_TOKEN}%00`, { bearer: null })).status, 404, "rec token + NUL");
      eq((await api(B, "GET", `/mcp/${T.KLARA_MCP_TOKEN}`, { bearer: null })).status, 405, "GET mcp 405");
    });

    await scenario("MCP: initialize, notification 202, tools/list, ping", async () => {
      let r = await mcp(B, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sim", version: "1" } });
      eq(r.status, 200, "init");
      eq(r.data.result.protocolVersion, "2025-06-18", "protocol");
      const n = await fetch(`${B}/mcp/${T.KLARA_MCP_TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
      eq(n.status, 202, "notification");
      r = await mcp(B, "tools/list", {});
      const names = r.data.result.tools.map((t) => t.name).sort().join(",");
      eq(names, "daily_digest,get_meeting,list_meetings,search_meetings", "tools");
      assert(r.data.result.tools.every((t) => t.annotations.readOnlyHint === true), "read-only hints");
      eq((await mcp(B, "ping", {})).data.result && 1, 1, "ping");
    });

    await scenario("MCP tools: list_meetings, get_meeting latest, Hebrew search with a prefix, daily_digest", async () => {
      let t = await toolText(B, "list_meetings", {});
      assert(t.text.includes(m1.id) && t.text.includes("(עודכן)"), "list has the meeting");
      t = await toolText(B, "get_meeting", { id: "latest" });
      assert(t.text.includes("סוכם להגדיל") && t.text.includes("<meeting_content>"), "latest has summary and transcript");
      t = await toolText(B, "search_meetings", { query: "קמפיין" });
      assert(t.text.includes(m1.id), "search קמפיין");
      t = await toolText(B, "search_meetings", { query: "תקציב" }); // inside בתקציב / התקציב
      assert(t.text.includes(m1.id), "search inside prefixed word");
      t = await toolText(B, "search_meetings", { query: "50%_" });
      assert(t.text.startsWith("No meetings"), "LIKE wildcards are escaped");
      t = await toolText(B, "list_meetings", { query: "דוד" });
      assert(t.text.includes(m1.id), "list by participant");
      t = await toolText(B, "daily_digest", {});
      assert(t.text.includes(m1.id) || t.text.startsWith("No calls"), "digest");
      t = await toolText(B, "get_meeting", { id: "nope" });
      assert(t.isError, "unknown id is a tool error");
    });

    await scenario("MCP: SQL injection attempts are plain text", async () => {
      for (const q of [`' OR 1=1 --`, `"; DROP TABLE meetings; --`, `%' UNION SELECT transcript FROM meetings --`]) {
        const t = await toolText(B, "search_meetings", { query: q });
        assert(t.text.startsWith("No meetings"), `injection ${q}`);
        const g = await toolText(B, "get_meeting", { id: q });
        assert(g.isError, "get_meeting injection");
      }
      const t = await toolText(B, "list_meetings", {});
      assert(t.text.includes(m1.id), "table still there");
    });

    await scenario("MCP: batch of 3, notifications only → 202, over 20 → 400", async () => {
      const body = [1, 2, 3].map((i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
      let r = await fetch(`${B}/mcp/${T.KLARA_MCP_TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      eq((await r.json()).length, 3, "batch replies");
      r = await fetch(`${B}/mcp/${T.KLARA_MCP_TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array(21).fill({ jsonrpc: "2.0", id: 1, method: "ping" })) });
      eq(r.status, 400, "batch too large");
    });

    await scenario("large Hebrew transcript (1.9 MB of UTF-8): stored by real D1, read back in parts byte-exact", async () => {
      const line = (i) => `**דובר ${i % 3 + 1}** [${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}]\nזה משפט ארוך בעברית על התקציב, הלקוחות והפרויקט 🚀 מספר ${i}.\n\n`;
      let transcript = "";
      for (let i = 0; Buffer.byteLength(transcript) < 1_900_000; i++) transcript += line(i);
      const m = meeting({ id: "m_large", transcript, startedAt: new Date(Date.now() - 1000).toISOString() });
      const r = await api(B, "POST", "/api/meetings", { body: m });
      eq(r.status, 200, `upload ${Buffer.byteLength(transcript)} bytes: ${JSON.stringify(r.data)}`);
      let offset = 0;
      let joined = "";
      let parts = 0;
      for (;;) {
        const t = await toolText(B, "get_meeting", { id: "m_large", offset });
        // The last wrapper is the transcript (the first holds the meeting's details).
        const body = t.text.slice(t.text.lastIndexOf("<meeting_content>\n") + 18, t.text.lastIndexOf("\n</meeting_content>"));
        joined += body;
        parts++;
        const next = /offset (\d+)\./.exec(t.text.slice(t.text.lastIndexOf("</meeting_content>")));
        if (!next) break;
        offset = Number(next[1]);
      }
      eq(joined.length, transcript.length, "joined length");
      assert(joined === transcript, "joined parts equal the transcript (no lost or split surrogate pairs)");
      assert(parts >= 10, `parts ${parts}`);
      const s = await toolText(B, "search_meetings", { query: '"מספר 4321."' });
      assert(s.text.includes("m_large"), "search inside the large transcript");
    });

    await scenario("transcript over 2 MB → 413; transcript + summary over D1's 2 MB row → clear 413, not 500", async () => {
      let r = await api(B, "POST", "/api/meetings", { body: meeting({ transcript: "א".repeat(1_000_001) }) });
      eq(r.status, 413, "2,000,002 bytes transcript");
      // Local D1 (SQLite) would store this; the real D1 caps a row at 2,000,000 bytes, so the Worker refuses it itself.
      r = await api(B, "POST", "/api/meetings", { body: meeting({ transcript: "a".repeat(1_950_000), summary: "ב".repeat(99_000) }) });
      eq(r.status, 413, `row over 2 MB must be refused with 413 (${JSON.stringify(r.data)})`);
      assert(/together/.test(r.data.error), "message");
    });

    // ---------- phone recordings ----------
    const chunks = [randomBytes(1_000_000), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(777_777), randomBytes(1)];
    let rid;
    await scenario("recordings: start (idempotent clientId), chunks (idempotent), missing-chunk 409, finish, list", async () => {
      const startBody = { title: "פגישה במשרד", kind: "inperson", mime: "audio/webm;codecs=opus", startedAt: new Date().toISOString(), clientId: "abcdef0123456789" };
      let r = await rec(B, "/start", { body: startBody });
      eq(r.status, 200, `start ${JSON.stringify(r.data)}`);
      rid = r.data.id;
      r = await rec(B, "/start", { body: startBody });
      eq(r.data.id, rid, "same clientId → same id");
      // seq 1 first, then 0, 3, then 0 again (retry), then finish with 2 missing.
      for (const seq of [1, 0, 3, 0]) eq((await rec(B, `/chunk?id=${rid}&seq=${seq}`, { raw: chunks[seq] })).status, 200, `chunk ${seq}`);
      r = await rec(B, `/finish?id=${rid}`, { body: { chunks: 4, durationSec: 31 } });
      eq(r.status, 409, "missing chunk");
      eq(JSON.stringify(r.data.missing), "[2]", "missing list");
      r = await api(B, "GET", `/api/recordings/${rid}/audio`);
      eq(r.status, 409, "audio while uploading");
      r = await api(B, "POST", `/api/recordings/${rid}/claim`);
      eq(r.status, 409, "claim while uploading");
      eq((await rec(B, `/chunk?id=${rid}&seq=2`, { raw: chunks[2] })).status, 200, "chunk 2");
      eq((await rec(B, `/chunk?id=${rid}&seq=1`, { raw: randomBytes(10) })).status, 200, "a retried seq with other bytes is ignored");
      r = await rec(B, `/finish?id=${rid}`, { body: { chunks: 4, durationSec: 31, title: "פגישה במשרד 2" } });
      eq(r.status, 200, "finish");
      r = await rec(B, `/finish?id=${rid}`, { body: { chunks: 4, durationSec: 31 } });
      eq(r.status, 200, "finish twice");
      eq((await rec(B, `/chunk?id=${rid}&seq=4`, { raw: chunks[3] })).status, 409, "chunk after finish");
      r = await api(B, "GET", "/api/recordings?status=ready");
      const row = r.data.recordings.find((x) => x.id === rid);
      eq(row?.bytes, chunks.reduce((n, c) => n + c.length, 0), "bytes");
      eq(row.chunks, 4, "chunks");
      eq(row.title, "פגישה במשרד 2", "title from finish");
      eq(row.durationSec, 31, "duration");
    });

    await scenario("recordings: audio is byte-exact through real D1 BLOBs, with Content-Length and X-Recording-Bytes", async () => {
      const r = await fetch(`${B}/api/recordings/${rid}/audio`, { headers: { authorization: `Bearer ${T.KLARA_TOKEN}` } });
      eq(r.status, 200, "audio");
      const got = Buffer.from(await r.arrayBuffer());
      const want = Buffer.concat(chunks);
      eq(got.length, want.length, "length");
      eq(createHash("sha256").update(got).digest("hex"), createHash("sha256").update(want).digest("hex"), "sha256");
      eq(r.headers.get("x-recording-bytes"), String(want.length), "X-Recording-Bytes");
      eq(r.headers.get("content-length"), String(want.length), "Content-Length (FixedLengthStream)");
      eq(r.headers.get("content-type"), "audio/webm;codecs=opus", "mime");
    });

    await scenario("recordings: claim, second claim 409, delete, audio 404, delete again → 0", async () => {
      let r = await api(B, "POST", `/api/recordings/${rid}/claim`);
      eq(r.status, 200, "claim");
      eq(r.data.recording.status, "processing", "processing");
      eq((await api(B, "POST", `/api/recordings/${rid}/claim`)).status, 409, "second claim");
      r = await api(B, "GET", "/api/recordings?status=processing");
      assert(r.data.recordings.some((x) => x.id === rid), "listed as processing");
      r = await api(B, "DELETE", `/api/recordings/${rid}`);
      eq(r.data.deleted, 1, "deleted");
      eq((await api(B, "GET", `/api/recordings/${rid}/audio`)).status, 404, "audio gone");
      eq((await api(B, "DELETE", `/api/recordings/${rid}`)).data.deleted, 0, "deleted again");
      r = await api(B, "GET", "/api/recordings?status=bogus");
      eq(r.status, 400, "bad status filter");
    });

    await scenario("recordings: a 30 MB recording (31 chunks) streams in pages, byte-exact", async () => {
      let r = await rec(B, "/start", { body: { kind: "phone", mime: "audio/mp4", startedAt: new Date().toISOString() } });
      const id = r.data.id;
      const parts = [];
      for (let i = 0; i < 31; i++) {
        const c = randomBytes(i === 30 ? 12345 : 1_000_000);
        parts.push(c);
        eq((await rec(B, `/chunk?id=${id}&seq=${i}`, { raw: c })).status, 200, `chunk ${i}`);
      }
      eq((await rec(B, `/finish?id=${id}`, { body: { chunks: 31, durationSec: 3600 } })).status, 200, "finish");
      const a = await fetch(`${B}/api/recordings/${id}/audio`, { headers: { authorization: `Bearer ${T.KLARA_TOKEN}` } });
      const got = Buffer.from(await a.arrayBuffer());
      const want = Buffer.concat(parts);
      assert(got.equals(want), `30 MB byte-exact (${got.length} vs ${want.length})`);
      eq((await api(B, "DELETE", `/api/recordings/${id}`)).data.deleted, 1, "delete");
    });

    await scenario("recordings: validation (empty chunk, too big chunk, bad seq, bad mime, unknown id)", async () => {
      let r = await rec(B, "/start", { body: { kind: "phone", mime: "audio/webm", startedAt: new Date().toISOString() } });
      const id = r.data.id;
      eq((await rec(B, `/chunk?id=${id}&seq=0`, { raw: new Uint8Array(0) })).status, 400, "empty chunk");
      eq((await rec(B, `/chunk?id=${id}&seq=0`, { raw: randomBytes(1_000_001) })).status, 413, "chunk over 1 MB");
      eq((await rec(B, `/chunk?id=${id}&seq=5000`, { raw: randomBytes(5) })).status, 413, "seq 5000");
      eq((await rec(B, `/chunk?id=${id}&seq=-1`, { raw: randomBytes(5) })).status, 400, "seq -1");
      eq((await rec(B, `/chunk?id=r_0000000000000000&seq=0`, { raw: randomBytes(5) })).status, 404, "unknown id");
      eq((await rec(B, "/start", { body: { kind: "phone", mime: "text/html", startedAt: new Date().toISOString() } })).status, 400, "mime");
      eq((await rec(B, "/start", { body: { kind: "video", mime: "audio/webm", startedAt: new Date().toISOString() } })).status, 400, "kind");
      eq((await api(B, "DELETE", `/api/recordings/${id}`)).data.deleted, 1, "cleanup");
    });

    await scenario("recordings: storage quota (KLARA_REC_QUOTA_MB=40) → 507 with a clear message", async () => {
      let r = await rec(B, "/start", { body: { kind: "phone", mime: "audio/webm", startedAt: new Date().toISOString() } });
      const id = r.data.id;
      let status = 200;
      let i = 0;
      for (; i < 60 && status === 200; i++) {
        const res = await rec(B, `/chunk?id=${id}&seq=${i}`, { raw: randomBytes(1_000_000) });
        status = res.status;
        if (status !== 200) r = res;
      }
      eq(status, 507, "quota");
      assert(/full/.test(r.data.error), "message");
      assert(i >= 39 && i <= 41, `stopped near 40 MB (chunk ${i})`);
      eq((await rec(B, "/start", { body: { kind: "phone", mime: "audio/webm", startedAt: new Date().toISOString() } })).status, 507, "start refused when full");
      eq((await api(B, "DELETE", `/api/recordings/${id}`)).data.deleted, 1, "cleanup");
    });

    await scenario("recordings: 50 chunks of 1 MB sent 10 at a time never pass the 40 MB cap (limit checked inside the D1 batch)", async () => {
      const r = await rec(B, "/start", { body: { kind: "phone", mime: "audio/webm", startedAt: new Date().toISOString() } });
      const id = r.data.id;
      const statuses = [];
      for (let i = 0; i < 50; i += 10) {
        const batch = await Promise.all(Array.from({ length: 10 }, (_, k) => rec(B, `/chunk?id=${id}&seq=${i + k}`, { raw: randomBytes(1_000_000) })));
        statuses.push(...batch.map((x) => x.status));
      }
      const stored = statuses.filter((s) => s === 200).length;
      assert(statuses.every((s) => s === 200 || s === 507), `statuses ${statuses.join(",")}`);
      assert(stored <= 40, `stored ${stored} MB, over the 40 MB cap`);
      const list = await api(B, "GET", "/api/recordings?status=recording");
      const row = list.data.recordings.find((x) => x.id === id);
      eq(row.bytes, stored * 1_000_000, "bytes column matches the stored chunks");
      eq((await api(B, "DELETE", `/api/recordings/${id}`)).data.deleted, 1, "cleanup");
    });

    await scenario("recordings: 20 unfinished at once, the 21st → 429", async () => {
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push((await rec(B, "/start", { body: { kind: "phone", mime: "audio/webm", startedAt: new Date().toISOString() } })).data.id);
      eq((await rec(B, "/start", { body: { kind: "phone", mime: "audio/webm", startedAt: new Date().toISOString() } })).status, 429, "21st");
      for (const id of ids) await api(B, "DELETE", `/api/recordings/${id}`);
    });

    await scenario("phone page: CSP with nonce, no external resources, manifest, icon", async () => {
      const r = await fetch(`${B}/rec/${T.KLARA_REC_TOKEN}`);
      eq(r.status, 200, "page");
      const csp = r.headers.get("content-security-policy");
      const nonce = /nonce-([0-9a-f]+)/.exec(csp)[1];
      const html = await r.text();
      assert(csp.includes("connect-src 'self'") && csp.includes("default-src 'none'"), "csp");
      assert(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, "")), "no external URLs");
      assert(html.includes(`nonce="${nonce}"`), "nonce in page");
      const m = await fetch(`${B}/rec/${T.KLARA_REC_TOKEN}/manifest.webmanifest`, { headers: { "accept-language": "he-IL" } });
      eq((await m.json()).dir, "rtl", "Hebrew manifest");
      const icon = await fetch(`${B}/rec/${T.KLARA_REC_TOKEN}/icon-192.png`);
      eq(icon.headers.get("content-type"), "image/png", "icon");
    });
  } finally {
    await w.stop();
  }

  // ---------- an old deployment (v0.1.3 schema: meetings only) upgraded by redeploying the Worker ----------
  await scenario("old v0.1.3 schema: recording tables made on first use; meetings and MCP keep working", async () => {
    const old = execFileSync("git", ["show", "v0.1.3:cloudflare/schema.sql"], { cwd: REPO, encoding: "utf8" });
    assert(!old.includes("recordings"), "the old schema has no recording tables");
    const dir2 = makeProject({ schema: old, vars: T });
    applySql(dir2, `INSERT INTO meetings (id, title, started_at, transcript, updated_at) VALUES ('m_old', 'ישנה', '2026-10-01T08:00:00.000Z', 'שלום', '2026-10-01T09:00:00.000Z');`);
    const w2 = await startWorker(dir2);
    try {
      // First request after the upgrade is the phone: the tables appear by themselves.
      let r = await rec(w2.url, "/start", { body: { kind: "inperson", mime: "audio/webm", startedAt: new Date().toISOString() } });
      eq(r.status, 200, `start on old schema ${JSON.stringify(r.data)}`);
      eq((await rec(w2.url, `/chunk?id=${r.data.id}&seq=0`, { raw: randomBytes(100) })).status, 200, "chunk");
      eq((await rec(w2.url, `/finish?id=${r.data.id}`, { body: { chunks: 1, durationSec: 1 } })).status, 200, "finish");
      r = await api(w2.url, "GET", "/api/recordings?status=ready");
      eq(r.data.recordings.length, 1, "listed");
      const t = await toolText(w2.url, "get_meeting", { id: "m_old" });
      assert(t.text.includes("ישנה"), "old meeting readable");
    } finally {
      await w2.stop();
    }
    // A second Worker start (new isolate) on the now-upgraded database is fine too.
    const w3 = await startWorker(dir2);
    try {
      eq((await api(w3.url, "GET", "/api/recordings")).status, 200, "list after restart");
    } finally {
      await w3.stop();
    }
  });

  await scenario("no schema at all: a clear 500 for meetings; /rec still works (tables made lazily)", async () => {
    const dir3 = makeProject({ schema: null, vars: T });
    const w4 = await startWorker(dir3);
    try {
      const r = await api(w4.url, "POST", "/api/meetings", { body: meeting() });
      eq(r.status, 500, "meetings without schema");
      assert(/schema\.sql/.test(r.data.error), "message names schema.sql");
      eq((await rec(w4.url, "/start", { body: { kind: "inperson", mime: "audio/webm", startedAt: new Date().toISOString() } })).status, 200, "rec start");
    } finally {
      await w4.stop();
    }
  });

  return summary("routes (wrangler dev)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
