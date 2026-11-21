// Team cloud end to end against the real runtime (`wrangler dev`, workerd with a local D1): the owner and two
// members, with the app's own invite code (src/shared/team.ts), payload (src/main/cloudPayload.ts) and phone
// recordings puller (src/main/recordingsPull.ts). It checks what every connector can see, that a member's phone
// recordings go only to that member's computer, the per-member limits, removing a member, and an older
// deployment upgraded by redeploying.
// Run: bash scripts/cloud-sim/run.sh team
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { REPO, SCHEMA_SQL, makeProject, startWorker, token, scenario, summary, assert, eq, applySql, querySql } from "./lib.mjs";
import { buildInvite, parseInvite, parseJoinResponse, parseTeamInfo, autoShareDecision } from "../../src/shared/team.ts";
import { fitMeetingPayload } from "../../src/main/cloudPayload.ts";
import { RecordingsPuller, parseRecordingList } from "../../src/main/recordingsPull.ts";

const T = { KLARA_TOKEN: token(), KLARA_MCP_TOKEN: token(), KLARA_REC_TOKEN: token() };
const schema = readFileSync(SCHEMA_SQL, "utf8");
const WORK = mkdtempSync(join(tmpdir(), "klara-cloud-sim-team-"));
const secrets = []; // every member token, invite code and team connector token seen, for the log check

async function api(base, method, path, { body, bearer } = {}) {
  const h = {};
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
}

let rpcId = 0;
async function toolAs(base, tok, name, args = {}) {
  const r = await fetch(`${base}/mcp/${tok}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  eq(r.status, 200, `${name} status`);
  const data = await r.json();
  return { text: data.result.content[0].text, isError: !!data.result.isError };
}

/** The app's join: the owner's invite text → parseInvite → POST /api/team/join → parseJoinResponse. */
async function invite(base, name) {
  const r = await api(base, "POST", "/api/team/members", { body: { name }, bearer: T.KLARA_TOKEN });
  eq(r.status, 200, `invite ${name}: ${JSON.stringify(r.data)}`);
  const text = buildInvite({ url: base, code: r.data.invite.code });
  secrets.push(r.data.invite.code, text);
  return { id: r.data.member.id, text };
}
async function joinWith(text) {
  const inv = parseInvite(`Hi! Here is your invite:\n${text}\nSee you`, { allowLocalHttp: true });
  const r = await api(inv.url, "POST", "/api/team/join", { body: { code: inv.code } });
  eq(r.status, 200, `join: ${JSON.stringify(r.data)}`);
  const joined = parseJoinResponse(r.data);
  assert(joined, "join answer parses");
  secrets.push(...Object.values(joined.tokens));
  return { id: joined.member.id, name: joined.member.name, ownerName: joined.ownerName, ...joined.tokens };
}

const meeting = (id, word, over = {}) =>
  fitMeetingPayload({
    id, title: `פגישה ${word}`, startedAt: new Date(Date.now() - 3600_000).toISOString(), durationSec: 600, source: "zoom",
    participants: ["דוד"], scope: null, calendarTitle: null,
    transcript: `**דובר 1** [00:01]\nהמילה היא ${word}\n`, summary: `## תקציר\n${word}\n`, ...over,
  });

const WORDS = ["ownershared", "ownerprivate", "danashared", "danaprivate", "yossishared", "yossiprivate", "danaauto"];

/** Every word a connector can reach, through all four tools. */
async function visible(base, tok) {
  const texts = [
    (await toolAs(base, tok, "list_meetings", { days: 3650, limit: 100 })).text,
    (await toolAs(base, tok, "daily_digest", {})).text,
    (await toolAs(base, tok, "get_meeting", { id: "latest" })).text,
  ];
  for (const w of WORDS) {
    const t = (await toolAs(base, tok, "search_meetings", { query: w })).text;
    if (!t.startsWith("No meetings contain")) texts.push(t);
  }
  for (const id of ["m_shared", "m_private", "m_auto"]) texts.push((await toolAs(base, tok, "get_meeting", { id })).text);
  const all = texts.join("\n");
  return WORDS.filter((w) => all.includes(w));
}

/** One person's computer pulling their phone recordings, wired like src/main/phoneRecordings.ts (decode and
 *  transcription stubbed: pull.mjs runs the real decoder). */
function computer(base, tok) {
  const req = (method, path, body) =>
    fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body, redirect: "error" });
  const meetings = new Map();
  let pending = [];
  const puller = new RecordingsPuller({
    canRun: () => true,
    features: async () => (await (await fetch(base + "/api/health")).json()).features,
    list: async () => {
      const out = [];
      for (const status of ["ready", "processing"]) {
        const r = await req("GET", `/api/recordings?status=${status}`);
        if (!r.ok) throw new Error(`list ${r.status}`);
        out.push(...parseRecordingList(await r.json()));
      }
      return out;
    },
    claim: async (id) => {
      const r = await req("POST", `/api/recordings/${id}/claim`, "{}");
      if (r.ok) return true;
      if ([404, 409, 410].includes(r.status)) return false;
      throw new Error(`claim ${r.status}`);
    },
    release: async (id) => void (await req("POST", `/api/recordings/${id}/release`, "{}")),
    download: async (id) => {
      const r = await req("GET", `/api/recordings/${id}/audio`);
      if (!r.ok) throw new Error(`download ${r.status}`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type") };
    },
    decode: async (rec, bytes) => {
      const p = join(WORK, `${rec.id}.pcm`);
      writeFileSync(p, bytes);
      return p;
    },
    findLocal: (recId) => {
      for (const m of meetings.values()) if (m.recId === recId) return { meetingId: m.id, status: "done" };
      return null;
    },
    removeLocal: (id) => meetings.delete(id),
    transcribe: async (rec, pcm) => {
      const id = `m_phone_${rec.id.slice(2, 10)}`;
      meetings.set(id, { id, recId: rec.id, title: rec.title, word: readFileSync(pcm, "utf8") });
      return id;
    },
    upload: async (id) => {
      const m = meetings.get(id);
      const r = await req("POST", "/api/meetings", JSON.stringify(meeting(id, m.word, { title: m.title, source: "phone" })));
      if (!r.ok) throw new Error(`upload ${r.status}`);
    },
    remove: async (id) => void (await req("DELETE", `/api/recordings/${id}`)),
    cleanup: (p) => rmSync(p, { force: true }),
    loadPending: () => pending,
    savePending: (l) => (pending = l),
    log: () => {},
  });
  return { puller, meetings };
}

async function phoneRecord(base, recToken, title, word) {
  const post = (path, init) => fetch(`${base}/rec/${recToken}${path}`, { method: "POST", ...init });
  const s = await (await post("/start", { headers: { "content-type": "application/json" }, body: JSON.stringify({ title, kind: "inperson", mime: "audio/webm", startedAt: new Date().toISOString(), clientId: "same-page-id-1234" }) })).json();
  assert(s.ok, `start: ${JSON.stringify(s)}`);
  eq((await post(`/chunk?id=${s.id}&seq=0`, { headers: { "content-type": "application/octet-stream" }, body: Buffer.from(word) })).status, 200, "chunk");
  eq((await post(`/finish?id=${s.id}`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ chunks: 1, durationSec: 5 }) })).status, 200, "finish");
  return s.id;
}

async function main() {
  const dir = makeProject({ schema, vars: { ...T, KLARA_MEMBER_QUOTA_MB: "0.05" } }); // 50 KB of meetings per member
  const w = await startWorker(dir);
  const B = w.url;
  console.log(`wrangler dev at ${B} (project ${dir})`);
  let dana, yossi, teamTok, teamId;

  try {
    await scenario("health: the Worker says it can do teams; a Worker with no members is a personal one", async () => {
      const h = await api(B, "GET", "/api/health");
      assert(h.data.features.includes("team"), "team feature");
      eq((await api(B, "POST", "/api/meetings", { body: meeting("m_solo", "solo"), bearer: T.KLARA_TOKEN })).status, 200, "owner upload");
      const me = await api(B, "GET", "/api/me", { bearer: T.KLARA_TOKEN });
      eq(me.data.role, "owner", "owner");
      eq(me.data.team.members, 0, "no members");
      const t = await toolAs(B, T.KLARA_MCP_TOKEN, "get_meeting", { id: "m_solo" });
      assert(t.text.includes("solo") && !/shared/.test(t.text), "personal Worker: nothing about sharing");
      eq((await api(B, "DELETE", "/api/meetings/m_solo", { bearer: T.KLARA_TOKEN })).data.deleted, 1, "delete");
    });

    await scenario("invite and join with the app's invite code; one use; tokens kept only as hashes in real D1", async () => {
      eq((await api(B, "PUT", "/api/team", { body: { ownerName: "קלרה" }, bearer: T.KLARA_TOKEN })).status, 200, "owner name");
      const a = await invite(B, "דנה");
      const b = await invite(B, "Yossi");
      dana = await joinWith(a.text);
      yossi = await joinWith(b.text);
      eq(dana.name, "דנה", "name");
      eq(dana.ownerName, "קלרה", "owner name");
      eq((await api(B, "POST", "/api/team/join", { body: { code: parseInvite(a.text, { allowLocalHttp: true }).code } })).status, 404, "second use");
      const info = parseTeamInfo((await api(B, "GET", "/api/team", { bearer: T.KLARA_TOKEN })).data);
      eq(info.members.map((m) => `${m.name}:${m.status}`).join(), "דנה:joined,Yossi:joined", "members");
      const tc = await api(B, "POST", "/api/team/connectors", { body: { label: "הצוות" }, bearer: T.KLARA_TOKEN });
      teamTok = tc.data.token;
      teamId = tc.data.connector.id;
      secrets.push(teamTok);
    });

    await scenario("uploads: same ids from three people, shared and unshared, one by Dana's automatic domain rule", async () => {
      const up = async (tok, id, word, shared) => {
        const body = shared === undefined ? meeting(id, word) : { ...meeting(id, word), shared };
        const r = await api(B, "POST", "/api/meetings", { body, bearer: tok });
        eq(r.status, 200, `${word}: ${JSON.stringify(r.data)}`);
      };
      await up(T.KLARA_TOKEN, "m_shared", "ownershared", true);
      await up(T.KLARA_TOKEN, "m_private", "ownerprivate", undefined); // an older app: no field, unshared
      await up(dana.upload, "m_shared", "danashared", true);
      await up(dana.upload, "m_private", "danaprivate", false);
      await up(yossi.upload, "m_shared", "yossishared", true);
      await up(yossi.upload, "m_private", "yossiprivate", false);
      // Dana's app decides "m_auto" with her rule (guests from acme.com), like src/main/cloudTeamState.ts does.
      const rule = { mode: "domains", domains: ["acme.com"], since: new Date(Date.now() - 86_400_000).toISOString() };
      const auto = autoShareDecision({ startedAt: new Date().toISOString(), attendees: [{ email: "dana@visitt.io", isMe: true }, { email: "ron@eu.acme.com" }] }, rule);
      eq(auto, true, "rule shares a meeting with an acme.com guest");
      await up(dana.upload, "m_auto", "danaauto", auto);
    });

    await scenario("visibility: each own connector sees only its own; the team connector only shared ones, with names", async () => {
      eq((await visible(B, T.KLARA_MCP_TOKEN)).join(), "ownershared,ownerprivate", "owner's connector");
      eq((await visible(B, dana.mcp)).join(), "danashared,danaprivate,danaauto", "Dana's connector");
      eq((await visible(B, yossi.mcp)).join(), "yossishared,yossiprivate", "Yossi's connector");
      eq((await visible(B, teamTok)).join(), "ownershared,danashared,yossishared,danaauto", "team connector");
      const list = (await toolAs(B, teamTok, "list_meetings", { days: 30 })).text;
      for (const n of ["קלרה", "דנה", "Yossi"]) assert(list.includes(`shared by: ${n}`), `shared by ${n}`);
      assert(list.indexOf("shared by") > list.indexOf("<meeting_content>"), "names inside the data wrapper");
      // Unshared ones can't be reached by their full id either.
      for (const id of [`${dana.id}:m_private`, `${yossi.id}:m_private`, "m_private"]) {
        eq((await toolAs(B, teamTok, "get_meeting", { id })).isError, true, `team get ${id}`);
      }
      eq((await toolAs(B, dana.mcp, "get_meeting", { id: `${yossi.id}:m_shared` })).isError, true, "Dana can't read Yossi's");
    });

    await scenario("sharing is the uploader's: Dana unshares at once; Yossi can't touch Dana's; tokens stay in their lanes", async () => {
      eq((await api(B, "POST", "/api/meetings/m_auto/share", { body: { shared: false }, bearer: dana.upload })).status, 200, "unshare");
      eq((await visible(B, teamTok)).join(), "ownershared,danashared,yossishared", "team after unshare");
      eq((await api(B, "POST", `/api/meetings/${encodeURIComponent(`${dana.id}:m_private`)}/share`, { body: { shared: true }, bearer: yossi.upload })).status, 404, "Yossi can't share Dana's");
      eq((await api(B, "GET", "/api/team", { bearer: dana.upload })).status, 403, "member on admin route");
      eq((await api(B, "POST", "/api/team/members", { body: { name: "x" }, bearer: yossi.upload })).status, 403, "member can't invite");
      for (const t of [dana.mcp, dana.rec, teamTok]) eq((await api(B, "GET", "/api/me", { bearer: t })).status, 401, "read-only tokens on /api");
      eq((await fetch(`${B}/mcp/${dana.upload}`, { method: "POST", body: "{}" })).status, 404, "upload token on /mcp");
      eq((await fetch(`${B}/rec/${teamTok}`)).status, 404, "team token on /rec");
    });

    await scenario("phone recordings: each person's link → only that person's computer pulls it (the app's puller)", async () => {
      const ra = await phoneRecord(B, dana.rec, "הקלטה של דנה", "danaphone");
      const ry = await phoneRecord(B, yossi.rec, "הקלטה של יוסי", "yossiphone");
      const ro = await phoneRecord(B, T.KLARA_REC_TOKEN, "הקלטה של קלרה", "ownerphone");
      assert(new Set([ra, ry, ro]).size === 3, "same page id from three phones: three recordings");
      const pcs = { dana: computer(B, dana.upload), yossi: computer(B, yossi.upload), owner: computer(B, T.KLARA_TOKEN) };
      // All three computers pull at once.
      const reports = await Promise.all(Object.values(pcs).map((pc) => pc.puller.pullOnce()));
      eq(reports.map((r) => r.imported.length).join(), "1,1,1", "one each");
      eq([...pcs.dana.meetings.values()][0].word, "danaphone", "Dana got hers");
      eq([...pcs.yossi.meetings.values()][0].word, "yossiphone", "Yossi got his");
      eq([...pcs.owner.meetings.values()][0].word, "ownerphone", "owner got hers");
      for (const tok of [dana.upload, yossi.upload, T.KLARA_TOKEN]) eq((await api(B, "GET", "/api/recordings", { bearer: tok })).data.recordings.length, 0, "cleaned up");
      // The transcripts went to each person's own space: unshared.
      assert((await visible(B, dana.mcp)).length >= 2, "Dana still sees hers");
      const team = (await toolAs(B, teamTok, "search_meetings", { query: "danaphone" })).text;
      assert(team.startsWith("No meetings contain"), "phone transcript not shared by default");
      assert(!(await toolAs(B, yossi.mcp, "search_meetings", { query: "danaphone" })).text.includes("id:"), "Yossi can't find it");
    });

    await scenario("per-member limit (KLARA_MEMBER_QUOTA_MB=0.05): a member gets a clear 507; the owner has no such limit", async () => {
      const big = "א".repeat(30_000); // 60 KB of UTF-8
      eq((await api(B, "POST", "/api/meetings", { body: meeting("m_big1", "big", { transcript: big }), bearer: yossi.upload })).status, 507, "over Yossi's room");
      const r = await api(B, "POST", "/api/meetings", { body: meeting("m_big1", "big", { transcript: big }), bearer: T.KLARA_TOKEN });
      eq(r.status, 200, "owner unlimited");
    });

    await scenario("removing Yossi: tokens stop, private data goes, shared kept and marked; a new invite moves Dana", async () => {
      const r = await api(B, "DELETE", `/api/team/members/${yossi.id}`, { body: { deleteShared: false }, bearer: T.KLARA_TOKEN });
      eq(r.status, 200, "remove");
      eq(r.data.keptShared, 1, "shared kept");
      eq((await api(B, "GET", "/api/me", { bearer: yossi.upload })).status, 401, "upload token revoked");
      eq((await fetch(`${B}/mcp/${yossi.mcp}`, { method: "POST", body: "{}" })).status, 404, "connector revoked");
      eq((await fetch(`${B}/rec/${yossi.rec}`)).status, 404, "phone link revoked");
      const t = (await toolAs(B, teamTok, "search_meetings", { query: "yossishared" })).text;
      assert(t.includes("shared by: Yossi (no longer in the team)"), "marked");
      assert((await toolAs(B, teamTok, "search_meetings", { query: "yossiprivate" })).text.startsWith("No meetings"), "private gone");
      // Dana on a new computer.
      const again = await api(B, "POST", `/api/team/members/${dana.id}/invite`, { bearer: T.KLARA_TOKEN });
      const moved = await joinWith(buildInvite({ url: B, code: again.data.invite.code }));
      secrets.push(again.data.invite.code);
      eq(moved.id, dana.id, "same member");
      eq((await api(B, "GET", "/api/me", { bearer: dana.upload })).status, 401, "old computer stops");
      eq((await visible(B, moved.mcp)).join(), "danashared,danaprivate,danaauto", "her meetings stay");
      // A deleted team connector stops.
      eq((await api(B, "DELETE", `/api/team/connectors/${teamId}`, { bearer: T.KLARA_TOKEN })).status, 200, "delete connector");
      eq((await fetch(`${B}/mcp/${teamTok}`, { method: "POST", body: "{}" })).status, 404, "team connector gone");
    });

    await scenario("the Worker's own log lines never include a token, invite code or transcript", async () => {
      const lines = w.output().split("\n").filter((l) => l.includes("[klara-gateway]"));
      for (const l of lines) {
        for (const s of [...secrets, T.KLARA_TOKEN, T.KLARA_MCP_TOKEN, T.KLARA_REC_TOKEN]) assert(!l.includes(s), "secret in a log line");
        assert(!/המילה היא/.test(l), "transcript in a log line");
      }
    });
  } finally {
    await w.stop();
  }

  await scenario("real D1 keeps only SHA-256 hashes of member tokens, invite codes and team connector tokens", async () => {
    const dump = JSON.stringify([querySql(dir, "SELECT * FROM members"), querySql(dir, "SELECT * FROM team_connectors")]);
    assert(secrets.length > 10, "secrets were collected");
    for (const s of secrets) assert(!dump.includes(s), "a plain token or code in D1");
    const sha = (s) => createHash("sha256").update(s).digest("hex");
    const rows = querySql(dir, "SELECT id, upload_hash, mcp_hash, rec_hash, removed_at FROM members ORDER BY created_at");
    const d = rows.find((r) => r.id === dana.id);
    assert(d && d.upload_hash && d.upload_hash !== sha(dana.upload), "Dana's first tokens were replaced by the new invite");
    const y = rows.find((r) => r.id === yossi.id);
    assert(y && y.removed_at && y.upload_hash === null && y.mcp_hash === null, "Yossi's hashes are gone (kept only for his shared meeting's name)");
  });

  await scenario("an older deployment (before teams) upgrades by redeploying: schema.sql reruns, data is the owner's, unshared", async () => {
    const old = execFileSync("git", ["show", "320d9f1:cloudflare/schema.sql"], { cwd: REPO, encoding: "utf8" });
    assert(!old.includes("uploaded_by") && old.includes("recordings"), "the old schema has recordings but no team columns");
    const dir2 = makeProject({ schema: old, vars: T });
    const now = new Date().toISOString(); // recent: the hourly cleanup deletes recordings left for 30 days
    applySql(dir2, `INSERT INTO meetings (id, title, started_at, transcript, updated_at) VALUES ('m_old', 'ישנה', '${now}', 'המילה היא oldword', '${now}');
      INSERT INTO recordings (id, title, mime, started_at, status, chunks, bytes, created_at, updated_at, finished_at) VALUES ('r_0000000000000000aaaa', 'old', 'audio/webm', '${now}', 'ready', 1, 3, '${now}', '${now}', '${now}');
      INSERT INTO recording_chunks VALUES ('r_0000000000000000aaaa', 0, x'010203');`);
    // The one-click update runs the new schema.sql first, over the old tables.
    applySql(dir2, schema);
    const w2 = await startWorker(dir2);
    try {
      assert((await toolAs(w2.url, T.KLARA_MCP_TOKEN, "get_meeting", { id: "m_old" })).text.includes("oldword"), "old meeting readable");
      eq((await api(w2.url, "GET", "/api/recordings", { bearer: T.KLARA_TOKEN })).data.recordings.length, 1, "old recording is the owner's");
      const inv = await invite(w2.url, "דנה");
      const d = await joinWith(inv.text);
      const tc = await api(w2.url, "POST", "/api/team/connectors", { body: { label: "t" }, bearer: T.KLARA_TOKEN });
      secrets.push(tc.data.token);
      assert((await toolAs(w2.url, tc.data.token, "list_meetings", { days: 3650 })).text.startsWith("No meetings"), "old meeting not shared");
      assert((await toolAs(w2.url, d.mcp, "search_meetings", { query: "oldword" })).text.startsWith("No meetings"), "member can't see it");
      eq((await api(w2.url, "GET", "/api/recordings", { bearer: d.upload })).data.recordings.length, 0, "member doesn't get the owner's recording");
    } finally {
      await w2.stop();
    }
    const [row] = querySql(dir2, "SELECT uploaded_by, shared FROM meetings WHERE id = 'm_old'");
    eq(`${row.uploaded_by}/${row.shared}`, "owner/0", "old row: the owner's, unshared");
  });

  rmSync(WORK, { recursive: true, force: true });
  return summary("team (wrangler dev)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
