// Shared helpers for the Cloudflare simulations (scripts/cloud-sim/README.md).
// Runs the real Worker in `wrangler dev` (workerd, Cloudflare's own runtime) with a local D1 in a temp folder.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import net from "node:net";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** CLOUD_SIM_WORKER runs another worker.js (e.g. an older one from git, to see a regression test fail). */
export const WORKER_JS = process.env.CLOUD_SIM_WORKER || join(REPO, "cloudflare/src/worker.js");
export const SCHEMA_SQL = join(REPO, "cloudflare/schema.sql");

/** Where wrangler (and playwright-core, when needed) are installed: run.sh sets CLOUD_SIM_DEPS. */
export const DEPS = process.env.CLOUD_SIM_DEPS || join(tmpdir(), "klara-cloud-sim-deps");
export const WRANGLER = join(DEPS, "node_modules/.bin/wrangler");

export const token = () => randomBytes(32).toString("hex");

/** wrangler with no metrics, no colors and its logs in a temp folder (not ~/Library/Preferences/.wrangler). */
const LOGS = mkdtempSync(join(tmpdir(), "klara-cloud-sim-wrangler-logs-"));
const wranglerEnv = () => ({ ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", WRANGLER_LOG_PATH: LOGS });

export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

/**
 * A temp folder with a wrangler.toml for `worker` (a file path) and a local D1.
 * `schema`: SQL text applied to the local D1 first (null: none).
 */
export function makeProject({ worker = WORKER_JS, schema, vars = {}, dir } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), "klara-cloud-sim-"));
  mkdirSync(dir, { recursive: true });
  const toml = [
    `name = "klara-wisper-gateway"`,
    `main = ${JSON.stringify(worker)}`,
    `compatibility_date = "2026-09-01"`,
    ``,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = "klara-wisper"`,
    `database_id = "00000000-0000-4000-8000-000000000000"`,
    ``,
  ].join("\n");
  writeFileSync(join(dir, "wrangler.toml"), toml);
  // Secrets the way `wrangler dev` reads them.
  writeFileSync(join(dir, ".dev.vars"), Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join("\n") + "\n");
  if (schema) applySql(dir, schema);
  return dir;
}

export function applySql(dir, sql) {
  const file = join(dir, `apply-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(file, sql);
  const r = spawnSync(WRANGLER, ["d1", "execute", "klara-wisper", "--local", "--persist-to", join(dir, "state"), "--file", file, "--yes"], {
    cwd: dir, encoding: "utf8", env: wranglerEnv(),
  });
  if (r.status !== 0) throw new Error(`d1 execute failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Rows of one SQL query on a project's local D1 (run while `wrangler dev` for it is stopped). */
export function querySql(dir, sql) {
  const r = spawnSync(WRANGLER, ["d1", "execute", "klara-wisper", "--local", "--persist-to", join(dir, "state"), "--command", sql, "--json"], {
    cwd: dir, encoding: "utf8", env: wranglerEnv(),
  });
  if (r.status !== 0) throw new Error(`d1 execute failed: ${r.stderr || r.stdout}`);
  const out = JSON.parse(r.stdout);
  return (Array.isArray(out) ? out[0] : out).results;
}

/** Starts `wrangler dev` for a project folder; resolves with {url, stop()} once /api/health answers. */
export async function startWorker(dir, { port, log = false } = {}) {
  port ??= await freePort();
  const inspector = await freePort();
  const child = spawn(
    WRANGLER,
    ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"],
    { cwd: dir, env: wranglerEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const keep = (b) => {
    output += b.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
    if (log) process.stderr.write(b);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${output}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > until) {
      child.kill("SIGKILL");
      throw new Error(`wrangler dev did not start:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    url,
    port,
    output: () => output,
    stop: () =>
      new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000);
      }),
  };
}

// ---------- a tiny test runner that prints a table ----------

export const results = [];

export async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  pass  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: err?.stack || String(err) });
    console.log(`  FAIL  ${name}\n${String(err?.stack || err).split("\n").map((l) => "        " + l).join("\n")}`);
  }
}

export function summary(title) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${title}: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  return failed.length;
}

export function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

export function eq(a, b, message) {
  if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

export { existsSync };
