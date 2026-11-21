// The one-click deploy (src/main/cloudflareApi.ts deployGateway, no Electron) against mock-cloudflare.mjs, whose
// uploaded Worker really runs in `wrangler dev`: the address the app computes must answer /api/health, and the
// tokens the app keeps must work on the deployed Worker.
// Run: bash scripts/cloud-sim/run.sh deploy
import { readFileSync, mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, WORKER_JS, SCHEMA_SQL, scenario, summary, assert, eq } from "./lib.mjs";
import { MockCloudflare } from "./mock-cloudflare.mjs";
import { CfError, deployGateway, parseWranglerToml, connectorUrl, phoneUrl } from "../../src/main/cloudflareApi.ts";

const A1 = "a".repeat(32);
const A2 = "b".repeat(32);
const config = parseWranglerToml(readFileSync(join(REPO, "cloudflare/wrangler.toml"), "utf8"));
const workerJs = readFileSync(WORKER_JS, "utf8");
const schemaSql = readFileSync(SCHEMA_SQL, "utf8");

function deps(cf, progress = []) {
  let n = 0;
  return {
    fetch: cf.fetchFor(),
    secret: () => randomBytes(32).toString("hex"),
    randomName: () => (++n === 1 ? "taken1" : `fresh${n}`), // the first name is already taken in the mock
    sleep: async () => undefined,
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    progress: (s, st, d) => progress.push(`${s}:${st}${d ? `(${d})` : ""}`),
  };
}

async function withCf(opts, fn) {
  const cf = await new MockCloudflare({ dir: mkdtempSync(join(tmpdir(), "klara-cloud-sim-cf-")), accounts: [{ id: A1, name: "Klara" }], ...opts }).start();
  try {
    return await fn(cf);
  } finally {
    await cf.stop();
  }
}

const deploy = (cf, apiToken, extra = {}, progress) =>
  deployGateway(deps(cf, progress), { apiToken, workerJs, schemaSql, config, healthTimeoutMs: 20_000, ...extra });

const rejects = async (p, check, what) => {
  try {
    await p;
  } catch (e) {
    assert(e instanceof CfError, `${what}: not a CfError: ${e}`);
    assert(check(e), `${what}: got ${e.code} at ${e.step} (${e.detail ?? ""})`);
    return e;
  }
  throw new Error(`${what}: did not fail`);
};

async function call(cf, url, init = {}) {
  const r = await cf.fetchFor()(url, init);
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
}

async function main() {
  await scenario("token problems: unknown token, expired, no account, several accounts, missing D1 permission, update with a key from another account", async () => {
    await withCf(
      {
        accounts: [{ id: A1, name: "Klara" }, { id: A2, name: "Visitt" }],
        tokens: {
          expired: { kind: "user", status: "expired" },
          none: { kind: "user", accounts: [] },
          multi: { kind: "user" },
          nod1: { kind: "user", accounts: [A1], deny: { d1: true } },
          other: { kind: "user", accounts: [A2] },
        },
      },
      async (cf) => {
        await rejects(deploy(cf, "nope"), (e) => e.code === "badToken" && e.step === "verify", "unknown token");
        await rejects(deploy(cf, "expired"), (e) => e.code === "badToken", "expired token");
        await rejects(deploy(cf, "none"), (e) => e.code === "noAccount", "no account");
        const e = await rejects(deploy(cf, "multi"), (e) => e.code === "chooseAccount", "several accounts");
        eq(e.accounts.map((a) => a.name).join(","), "Klara,Visitt", "accounts offered");
        await rejects(deploy(cf, "nod1"), (e) => e.code === "permission" && e.perm === "D1: Edit" && e.step === "database", "no D1 permission");
        const secrets = { upload: "u".repeat(64), mcp: "m".repeat(64), rec: "r".repeat(64) };
        await rejects(deploy(cf, "other", { secrets, accountId: A1 }), (e) => e.code === "wrongAccount", "update with a key from another account");
        assert(!cf.calls.some((c) => c.startsWith("PUT") && c.includes("/scripts/")), "nothing uploaded");
      },
    );
  });

  await scenario("fresh account: database made, schema applied, subdomain registered (first name taken), Worker runs and answers /api/health", async () => {
    await withCf({ tokens: { good: { kind: "user" } }, takenSubdomains: ["klara-taken1"] }, async (cf) => {
      const progress = [];
      let saved = null;
      const r = await deploy(cf, "good", { onUploaded: (s) => (saved = s) }, progress);
      eq(r.healthy, true, "healthy");
      assert(r.features.includes("recordings"), "features");
      eq(r.url, `https://klara-wisper-gateway.${r.subdomain}.workers.dev`, "url");
      assert(r.subdomain.startsWith("klara-fresh"), `a second name after the taken one (${r.subdomain})`);
      eq(JSON.stringify(saved), JSON.stringify(r.secrets), "all three secrets handed over at upload");
      eq(cf.problems.join("; "), "", "request shapes Cloudflare accepts");
      const up = cf.acct(A1).scripts.get("klara-wisper-gateway");
      eq(up.meta.main_module, "worker.js", "main_module");
      eq(up.meta.observability.enabled, false, "observability off");
      eq(up.meta.compatibility_date, config.compatibilityDate, "compatibility_date from wrangler.toml");
      eq(up.enabled, true, "workers.dev route on");
      // The tokens the app keeps work on the deployed Worker, each only where it should.
      const meeting = { id: "m_deploy", title: "שיחה ראשונה", startedAt: new Date().toISOString(), durationSec: 60, source: "zoom", participants: [], transcript: "**אני** [00:01]\nבדיקה אחרי ההקמה\n" };
      let res = await call(cf, `${r.url}/api/meetings`, { method: "POST", headers: { authorization: `Bearer ${r.secrets.upload}`, "content-type": "application/json" }, body: JSON.stringify(meeting) });
      eq(res.status, 200, `upload with the app token (schema applied through /query): ${JSON.stringify(res.body)}`);
      res = await call(cf, connectorUrl(r.url, r.secrets.mcp), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_meeting", arguments: { id: "latest" } } }) });
      assert(res.body.result.content[0].text.includes("בדיקה אחרי ההקמה"), "connector reads it");
      eq((await call(cf, phoneUrl(r.url, r.secrets.rec))).status, 200, "phone page");
      eq((await call(cf, `${r.url}/api/recordings`, { headers: { authorization: `Bearer ${r.secrets.mcp}` } })).status, 401, "connector token can't use /api");
      assert(progress.includes("health:done"), progress.join(" "));

      // ---- run the setup again (another computer, or after Forget) ----
      await rejects(deploy(cf, "good"), (e) => e.code === "workerExists" && e.step === "secrets", "setup again: workerExists");
      eq((await call(cf, `${r.url}/api/meetings`, { method: "POST", headers: { authorization: `Bearer ${r.secrets.upload}`, "content-type": "application/json" }, body: JSON.stringify(meeting) })).status, 200, "nothing changed: old tokens still work");

      // ---- update keeping tokens: same secrets, data kept, nothing new created ----
      const before = cf.calls.length;
      const u = await deploy(cf, "good", { secrets: r.secrets });
      eq(u.url, r.url, "same address");
      const calls = cf.calls.slice(before);
      assert(!calls.some((c) => c.startsWith("POST") && c.endsWith("/d1/database")), "no new database");
      assert(!calls.some((c) => c.startsWith("PUT") && c.endsWith("/workers/subdomain")), "no new subdomain");
      res = await call(cf, connectorUrl(r.url, r.secrets.mcp), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_meetings", arguments: {} } }) });
      assert(res.body.result.content[0].text.includes("m_deploy"), "meetings survive the update");

      // ---- rotate the phone link ----
      const rec2 = randomBytes(32).toString("hex");
      await deploy(cf, "good", { secrets: { ...r.secrets, rec: rec2 } });
      eq((await call(cf, phoneUrl(r.url, r.secrets.rec))).status, 404, "old phone link gone");
      eq((await call(cf, phoneUrl(r.url, rec2))).status, 200, "new phone link");
      eq((await call(cf, `${r.url}/api/recordings`, { headers: { authorization: `Bearer ${r.secrets.upload}` } })).status, 200, "app token unchanged");

      // ---- replace all tokens (the user said yes) ----
      const z = await deploy(cf, "good", { replaceExisting: true });
      assert(z.secrets.upload !== r.secrets.upload, "new upload token");
      eq((await call(cf, `${r.url}/api/recordings`, { headers: { authorization: `Bearer ${r.secrets.upload}` } })).status, 401, "old app token refused");
      eq((await call(cf, `${r.url}/api/recordings`, { headers: { authorization: `Bearer ${z.secrets.upload}` } })).status, 200, "new app token works");
    });
  });

  await scenario("account-owned token (not a user token), D1 already there, subdomain already set, slow DNS for the new address", async () => {
    await withCf({ tokens: { acct: { kind: "account" } }, healthDelay: 4 }, async (cf) => {
      cf.acct(A1).subdomain = "klara-home";
      cf.acct(A1).dbs.push({ uuid: "11111111-2222-4333-8444-555555555555", name: "klara-wisper" });
      const r = await deploy(cf, "acct");
      eq(r.healthy, true, "healthy after a few tries");
      eq(r.databaseId, "11111111-2222-4333-8444-555555555555", "existing database reused");
      eq(r.subdomain, "klara-home", "existing subdomain");
      assert(!cf.calls.some((c) => c.startsWith("POST") && c.endsWith("/d1/database")), "no database made");
    });
  });

  await scenario("the address never answers in time: deployed, marked not healthy (sync starts by itself later)", async () => {
    await withCf({ tokens: { good: { kind: "user" } }, healthDelay: 1_000_000 }, async (cf) => {
      const progress = [];
      const r = await deploy(cf, "good", { healthTimeoutMs: 5_000 }, progress);
      eq(r.healthy, false, "not healthy");
      assert(progress.includes("health:skipped(slow)"), progress.join(" "));
    });
  });

  await scenario("a failure after the upload (route step): the three new tokens were already handed over", async () => {
    await withCf({ tokens: { noroute: { kind: "user" } } }, async (cf) => {
      // The subdomain call for the script fails like a Cloudflare outage.
      const orig = cf.route.bind(cf);
      cf.route = async (req, path, url, body) => (/\/scripts\/[\w-]+\/subdomain$/.test(path) ? [503, { success: false, errors: [{ code: 10013, message: "Service unavailable" }] }] : orig(req, path, url, body));
      let saved = null;
      await rejects(deploy(cf, "noroute", { onUploaded: (s) => (saved = s) }), (e) => e.step === "route" && e.code === "cloudflareDown", "route fails");
      assert(saved?.upload && saved?.mcp && saved?.rec, "upload, connector and phone tokens saved before the failure");
      const live = cf.acct(A1).scripts.get("klara-wisper-gateway").secrets;
      eq(live.KLARA_TOKEN, saved.upload, "the Worker's upload token is the one the computer kept");
    });
  });

  return summary("one-click deploy (mock Cloudflare API + wrangler dev)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
