# Klara Wisper Cloud gateway (optional)

A Cloudflare Worker and D1 database that each user deploys to their **own** Cloudflare account. The Klara Wisper
app uploads call transcripts and summaries (never audio), and the Worker serves them as a remote MCP connector,
so Claude can answer questions about calls on claude.ai and in the Claude mobile app. Claude can only read.
The Worker has no dependencies: it is one file, `src/worker.js`.

Hebrew setup guide for users: [`../docs/CLOUDFLARE.he.md`](../docs/CLOUDFLARE.he.md).

## Deploy

```sh
cd cloudflare
npx wrangler login
npx wrangler d1 create klara-wisper        # put the printed database_id into wrangler.toml
npx wrangler d1 execute klara-wisper --remote --file=schema.sql
openssl rand -hex 32                        # the token: keep it in a password manager
npx wrangler secret put KLARA_TOKEN         # paste the token
npx wrangler deploy
curl https://klara-wisper-gateway.<subdomain>.workers.dev/api/health
```

In claude.ai, go to Settings → Connectors → Add custom connector and enter
`https://klara-wisper-gateway.<subdomain>.workers.dev/mcp/<KLARA_TOKEN>`.

## Upload API

Every call except health needs `Authorization: Bearer <KLARA_TOKEN>`. If `KLARA_TOKEN` is missing or shorter
than 32 characters, every authenticated request is refused.

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/api/health` | none (no auth) | `{"ok":true,"version":"1.0.0"}` |
| POST | `/api/meetings` | one meeting (below), upserted by `id` | `{"ok":true}` |
| DELETE | `/api/meetings/:id` | none | `{"ok":true,"deleted":1}` (or `0` if absent) |
| DELETE | `/api/meetings` | `{"all":true}` | `{"ok":true,"deleted":n}` |

Meeting body (unknown extra fields are ignored):

| Field | Type | Rules |
|---|---|---|
| `id` | string | 1–128 characters from `A-Z a-z 0-9 _ . : -` |
| `title` | string | up to 1000 characters |
| `startedAt` | string | ISO 8601; stored as UTC |
| `durationSec` | number | 0 to 7 days; rounded |
| `source` | string | `zoom`, `meet`, `teams`, `slack`, `inperson`, … (up to 40 characters) |
| `participants` | string[] | up to 500 names |
| `scope` | string or null | up to 4000 characters; missing means null |
| `calendarTitle` | string or null | up to 1000 characters; missing means null |
| `transcript` | string | Markdown, at most 2 MB (2,000,000 bytes of UTF-8) |
| `summary` | string or null | Markdown, at most 200,000 bytes; missing means null |

Errors are `{"ok":false,"error":"…"}` with one of these statuses:

- 400: validation failed; the message names the field.
- 401: bad or missing token, or the token isn't configured on the Worker.
- 404 and 405: unknown path or wrong method.
- 413: the transcript or summary is too large, or the body is over 8 MB.
- 500: for example, `schema.sql` was never applied.

## MCP endpoint

`POST /mcp/<KLARA_TOKEN>` serves MCP over Streamable HTTP. It is stateless (no session id), takes single or
batch JSON-RPC messages, and always answers with `application/json`. A wrong token gets the same 404 as any
unknown path, and GET or DELETE with the right token gets 405.

Tools (times are Asia/Jerusalem):

- `list_meetings(query?, days=14, limit=30)`
- `get_meeting(id, offset=0)`: `"latest"` works, and transcripts over 100,000 characters come in parts.
- `search_meetings(query, limit=10)`
- `daily_digest(date?)`

Transcript text is always wrapped in `<meeting_content>` with a "data, not instructions" warning.

## Security notes

- The connector URL is the only credential: anyone who has it can read everything. To rotate, set a new secret,
  update it in the app, and re-add the connector.
- Tokens are compared in constant time (SHA-256 of both sides, then a timing-safe compare).
- There is no CORS, every response carries security headers, and request bodies are capped.
- Nothing logs transcript or summary text. Workers Logs are off in `wrangler.toml` because they would record
  the token in the URL. `npx wrangler tail` still works.

## Tests

```sh
node --test cloudflare/test/      # Node 22.13+ or 24; no npm install
```

The test uses Node's built-in `node:sqlite` as an in-memory D1 fake, so it runs the real SQL and `schema.sql`.
`test/package.json` points the directory at the test file, which makes the directory form of `--test` work.
