// A small stand-in for the Cloudflare REST API (https://api.cloudflare.com/client/v4), with only the endpoints
// src/main/cloudflareApi.ts calls. It checks request shapes against Cloudflare's API reference (multipart script
// upload with a `metadata` part, `main_module` naming an `application/javascript+module` part, D1 bindings with
// `database_id`, `secret_text`/`plain_text` bindings, compatibility_date) and answers with Cloudflare's envelope
// ({success, errors: [{code, message}], result}). An uploaded Worker really runs: in `wrangler dev`, with its
// secrets and the local D1 that the /query endpoint wrote to.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeProject, startWorker, applySql } from "./lib.mjs";

const ok = (result, extra = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const err = (code, message) => ({ success: false, errors: [{ code, message }], messages: [], result: null });

/** Splits multipart/form-data into parts {name, filename, type, body}. */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("no boundary");
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts = [];
  let at = body.indexOf(boundary);
  while (at >= 0) {
    const start = at + boundary.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const headEnd = body.indexOf("\r\n\r\n", start);
    const next = body.indexOf(boundary, headEnd);
    if (headEnd < 0 || next < 0) throw new Error("malformed multipart");
    const head = body.subarray(start + 2, headEnd).toString();
    const content = body.subarray(headEnd + 4, next - 2); // minus the CRLF before the boundary
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head)?.[1] ?? "";
    parts.push({
      name: /\bname="([^"]*)"/.exec(disp)?.[1],
      filename: /\bfilename="([^"]*)"/.exec(disp)?.[1],
      type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim(),
      body: content,
    });
    at = next;
  }
  return parts;
}

/**
 * accounts: [{id, name}] reached by every token. tokens: {<token>: {kind: 'user'|'account', status?, accounts?: [ids],
 * deny?: {<area>: true} }} where area is 'd1', 'scripts', 'accounts' or 'subdomain'.
 */
export class MockCloudflare {
  constructor({ accounts, tokens, takenSubdomains = [], healthDelay = 0, dir }) {
    this.accounts = accounts;
    this.tokens = tokens;
    this.taken = new Set(takenSubdomains);
    this.healthDelay = healthDelay; // health checks that fail before the new address "reaches DNS"
    this.dir = dir; // the wrangler project folder (local D1 lives here)
    this.state = new Map(); // account id -> {subdomain, dbs: [{uuid, name}], scripts: Map(name -> {...})}
    this.calls = [];
    this.worker = null; // the running wrangler dev
    this.problems = []; // request shapes Cloudflare would refuse
  }

  acct(id) {
    if (!this.state.has(id)) this.state.set(id, { subdomain: null, dbs: [], scripts: new Map() });
    return this.state.get(id);
  }

  async start() {
    // The project folder (with its local D1) exists before any upload, so /query can write the schema.
    mkdirSync(join(this.dir, "uploaded"), { recursive: true });
    writeFileSync(join(this.dir, "uploaded", "worker.js"), "export default { fetch() { return new Response('not deployed', { status: 404 }) } }\n");
    makeProject({ worker: join(this.dir, "uploaded", "worker.js"), dir: this.dir });
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${this.server.address().port}/client/v4`;
    return this;
  }

  async stop() {
    await this.worker?.stop();
    await new Promise((r) => this.server.close(r));
  }

  async handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    this.calls.push(`${req.method} ${path}${url.search}`);
    let status = 200;
    let out;
    try {
      [status, out] = await this.route(req, path, url, body);
    } catch (e) {
      [status, out] = [500, err(10013, String(e.message))];
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  }

  async route(req, path, url, body) {
    const auth = /^Bearer (\S+)$/.exec(req.headers.authorization || "")?.[1];
    const tok = this.tokens[auth];
    if (!auth) return [400, err(6003, "Invalid request headers")];
    if (!tok) return [401, err(1000, "Invalid API Token")];
    const deny = tok.deny ?? {};
    const reach = (tok.accounts ?? this.accounts.map((a) => a.id));

    if (path === "/user/tokens/verify" && req.method === "GET") {
      if (tok.kind === "account") return [401, err(1000, "Invalid API Token")]; // an account-owned token isn't a user token
      return [200, ok({ id: "tok", status: tok.status ?? "active" })];
    }
    if (path === "/accounts" && req.method === "GET") {
      if (tok.status && tok.status !== "active") return [401, err(1000, "Invalid API Token")];
      if (deny.accounts) return [200, ok([])]; // no Account Settings: Read → an empty list
      return [200, ok(this.accounts.filter((a) => reach.includes(a.id)), { result_info: { page: 1, per_page: 50 } })];
    }
    const m = /^\/accounts\/([0-9a-f]{32})(\/.*)$/.exec(path);
    if (!m) return [404, err(7003, "Could not route to " + path)];
    const [, accountId, rest] = m;
    if (!reach.includes(accountId)) return [403, err(10000, "Authentication error")];
    const a = this.acct(accountId);
    const json = () => {
      if (!/application\/json/.test(req.headers["content-type"] || "")) this.problems.push(`${req.method} ${rest}: not JSON`);
      return JSON.parse(body.toString() || "{}");
    };

    // ---- D1 ----
    if (rest === "/d1/database" && req.method === "GET") {
      if (deny.d1) return [403, err(10000, "Authentication error")];
      const name = url.searchParams.get("name");
      const pp = Number(url.searchParams.get("per_page") ?? 20);
      if (pp < 10 || pp > 10000) this.problems.push(`d1 list per_page ${pp} out of 10..10000`);
      return [200, ok(a.dbs.filter((d) => !name || d.name.includes(name)))];
    }
    if (rest === "/d1/database" && req.method === "POST") {
      if (deny.d1) return [403, err(10000, "Authentication error")];
      const b = json();
      if (typeof b.name !== "string" || !b.name) return [400, err(7400, "name is required")];
      if (a.dbs.some((d) => d.name === b.name)) return [400, err(7502, "A database with that name already exists")];
      const db = { uuid: randomUUID(), name: b.name, created_at: new Date().toISOString(), version: "production" };
      a.dbs.push(db);
      return [200, ok(db)];
    }
    let q = /^\/d1\/database\/([0-9a-f-]{36})\/query$/.exec(rest);
    if (q && req.method === "POST") {
      if (deny.d1) return [403, err(10000, "Authentication error")];
      if (!a.dbs.some((d) => d.uuid === q[1])) return [404, err(7404, "database not found")];
      const b = json();
      if (typeof b.sql !== "string") return [400, err(7400, "sql is required")];
      // "Supports multiple statements, joined by semicolons, which will be executed as a batch."
      try {
        new DatabaseSync(":memory:").exec(b.sql); // the SQL is valid on its own
      } catch (e) {
        return [200, ok([{ success: false, error: String(e.message), results: [], meta: {} }])];
      }
      applySql(this.dir, b.sql); // and really applied to the Worker's local D1
      return [200, ok(b.sql.split(";").filter((s) => s.trim()).map(() => ({ success: true, results: [], meta: { changes: 0 } })))];
    }

    // ---- workers.dev subdomain of the account ----
    if (rest === "/workers/subdomain" && req.method === "GET") {
      if (deny.scripts) return [403, err(10000, "Authentication error")];
      if (!a.subdomain) return [404, err(10007, "This account does not have a workers.dev subdomain")];
      return [200, ok({ subdomain: a.subdomain })];
    }
    if (rest === "/workers/subdomain" && req.method === "PUT") {
      if (deny.scripts) return [403, err(10000, "Authentication error")];
      const b = json();
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(b.subdomain ?? "")) return [400, err(10031, "Invalid subdomain")];
      if (this.taken.has(b.subdomain)) return [409, err(10032, "Subdomain is already taken")];
      a.subdomain = b.subdomain;
      this.taken.add(b.subdomain);
      return [200, ok({ subdomain: b.subdomain })];
    }

    // ---- scripts ----
    if (rest === "/workers/scripts" && req.method === "GET") {
      if (deny.scripts) return [403, err(10000, "Authentication error")];
      return [200, ok([...a.scripts.keys()].map((id) => ({ id, created_on: "2026-01-01T00:00:00Z", has_modules: true })))];
    }
    q = /^\/workers\/scripts\/([\w-]+)$/.exec(rest);
    if (q && req.method === "PUT") {
      if (deny.scripts) return [403, err(10000, "Authentication error")];
      return this.upload(a, q[1], req, body);
    }
    q = /^\/workers\/scripts\/([\w-]+)\/subdomain$/.exec(rest);
    if (q && req.method === "POST") {
      if (deny.scripts) return [403, err(10000, "Authentication error")];
      const s = a.scripts.get(q[1]);
      if (!s) return [404, err(10007, "workers.api.error.script_not_found")];
      const b = json();
      if (typeof b.enabled !== "boolean") return [400, err(10021, "enabled is required")];
      if (b.previews_enabled !== undefined && typeof b.previews_enabled !== "boolean") this.problems.push("previews_enabled not boolean");
      s.enabled = b.enabled;
      s.previews = b.previews_enabled;
      return [200, ok({ enabled: s.enabled, previews_enabled: !!s.previews })];
    }
    return [404, err(7003, `No route for ${req.method} ${rest}`)];
  }

  async upload(a, name, req, body) {
    const ct = req.headers["content-type"] || "";
    if (!/^multipart\/form-data;/.test(ct)) return [400, err(10021, "Expected multipart/form-data")];
    let parts;
    try {
      parts = parseMultipart(body, ct);
    } catch (e) {
      return [400, err(10021, String(e.message))];
    }
    const metaPart = parts.find((p) => p.name === "metadata");
    if (!metaPart) return [400, err(10021, "No metadata part")];
    const meta = JSON.parse(metaPart.body.toString());
    if (!meta.main_module) return [400, err(10021, "main_module is required for module Workers")];
    const main = parts.find((p) => p.name === meta.main_module);
    if (!main) return [400, err(10021, `No such module "${meta.main_module}"`)];
    if (main.type !== "application/javascript+module") return [400, err(10021, `Module part must be application/javascript+module, got ${main.type}`)];
    if (meta.compatibility_date && !/^\d{4}-\d{2}-\d{2}$/.test(meta.compatibility_date)) return [400, err(10021, "bad compatibility_date")];
    if (!meta.compatibility_date) this.problems.push("no compatibility_date (it would default to 2021-11-02)");
    if (meta.observability !== undefined && typeof meta.observability?.enabled !== "boolean") this.problems.push("observability.enabled not boolean");
    const env = {};
    for (const b of meta.bindings ?? []) {
      if (typeof b.name !== "string" || !b.name) return [400, err(10021, "binding without a name")];
      if (b.type === "d1") {
        const id = b.database_id ?? b.id;
        if (!b.database_id) this.problems.push("d1 binding without database_id (id is the deprecated name)");
        if (!a.dbs.some((d) => d.uuid === id)) return [400, err(10021, `D1 database ${id} not found`)];
      } else if (b.type === "secret_text" || b.type === "plain_text") {
        if (typeof b.text !== "string") return [400, err(10021, `${b.type} ${b.name} needs text`)];
        env[b.name] = b.text;
      } else if (b.type !== "r2_bucket") {
        return [400, err(10021, `unknown binding type ${b.type}`)];
      }
    }
    const prev = a.scripts.get(name);
    const keep = new Set(meta.keep_bindings ?? []);
    if (prev && keep.has("secret_text")) for (const [k, v] of Object.entries(prev.secrets)) if (!(k in env)) env[k] = v;
    a.scripts.set(name, { enabled: prev?.enabled ?? false, secrets: env, meta });
    // Really run it: the module goes into the project folder, the secrets into .dev.vars, then wrangler dev restarts.
    mkdirSync(join(this.dir, "uploaded"), { recursive: true });
    const file = join(this.dir, "uploaded", meta.main_module);
    writeFileSync(file, main.body);
    makeProject({ worker: file, vars: env, dir: this.dir });
    await this.worker?.stop();
    this.worker = await startWorker(this.dir);
    this.healthFailures = 0;
    return [200, ok({ id: name, etag: "x", modified_on: new Date().toISOString() })];
  }

  /** What the app's fetch reaches: the API, or a workers.dev address (only once its script is enabled). */
  fetchFor() {
    return async (url, init) => {
      if (url.startsWith("https://api.cloudflare.com/client/v4")) return fetch(this.base + url.slice("https://api.cloudflare.com/client/v4".length), init);
      const m = /^https:\/\/([\w-]+)\.([\w-]+)\.workers\.dev(\/.*)$/.exec(url);
      if (m) {
        const [, script, sub, path] = m;
        const a = [...this.state.values()].find((x) => x.subdomain === sub);
        if (!a?.scripts.get(script)?.enabled || !this.worker) throw new TypeError("fetch failed (getaddrinfo ENOTFOUND)");
        if ((this.healthFailures = (this.healthFailures ?? 0) + 1) <= this.healthDelay) throw new TypeError("fetch failed (DNS not yet)");
        return fetch(this.worker.url + path, init);
      }
      throw new TypeError(`unexpected URL ${url}`);
    };
  }
}
