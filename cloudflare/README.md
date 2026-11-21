# Klara Wisper Cloud gateway (optional)

A Cloudflare Worker and D1 database that each user deploys to their **own** Cloudflare account. It does two things:

- **Claude from anywhere.** The Klara Wisper app uploads call transcripts and summaries, and the Worker serves
  them as a read-only remote MCP connector, so Claude can answer questions about calls on claude.ai and in the
  Claude mobile app.
- **Phone recording link.** A page at `/rec/<KLARA_REC_TOKEN>` records audio in the phone's browser and uploads it
  in 10-second chunks. The audio waits in D1 until the app on the computer downloads it, transcribes it locally,
  uploads the transcript as a meeting and deletes the audio.

The Worker has no dependencies: it is one file, `src/worker.js`. Audio is kept in D1 (not R2), so no payment
method is needed on the Cloudflare account.

User guides: [Hebrew](../docs/CLOUDFLARE.he.md), [English](../docs/CLOUDFLARE.en.md). Most users set this up from
the app (Settings → Cloud → "Set up automatically"); the commands below are the manual path.

## Deploy by hand

```sh
cd cloudflare
npx wrangler login
npx wrangler d1 create klara-wisper        # put the printed database_id into wrangler.toml
npx wrangler d1 execute klara-wisper --remote --file=schema.sql
openssl rand -hex 32                        # app token: for the app only, keep it in a password manager
npx wrangler secret put KLARA_TOKEN         # paste the app token
openssl rand -hex 32                        # connector token (read-only): a second, different value
npx wrangler secret put KLARA_MCP_TOKEN     # paste the connector token
openssl rand -hex 32                        # phone link token (upload-only): a third, different value
npx wrangler secret put KLARA_REC_TOKEN     # paste the phone link token
npx wrangler deploy
curl https://klara-wisper-gateway.<subdomain>.workers.dev/api/health
```

There are three tokens, each at least 32 characters, and all three must be different:

| Secret | Where it goes | What it can do |
|---|---|---|
| `KLARA_TOKEN` | `Authorization: Bearer` from the app to `/api`; kept in the app (Keychain / Credential Manager) | upload and delete meetings; list, download, claim and delete recordings |
| `KLARA_MCP_TOKEN` | the connector URL `/mcp/<token>` in claude.ai | read meetings only |
| `KLARA_REC_TOKEN` | the phone link `/rec/<token>` | upload new recordings only; it can't read or list anything |

In claude.ai, go to Settings → Connectors → Add custom connector and enter
`https://klara-wisper-gateway.<subdomain>.workers.dev/mcp/<KLARA_MCP_TOKEN>`. The phone link is
`https://klara-wisper-gateway.<subdomain>.workers.dev/rec/<KLARA_REC_TOKEN>`.

**Upgrading an older deployment:** redeploy the Worker and add `KLARA_REC_TOKEN`. The recording tables are created
by the Worker on first use (`CREATE TABLE IF NOT EXISTS`, once per isolate), so re-running `schema.sql` is optional.

Optional plain variable: `KLARA_REC_QUOTA_MB` (default `400`), the most audio kept in the cloud at once. D1's free
plan allows 500 MB per database, and transcripts share that space.

## App API

Every call except health needs `Authorization: Bearer <KLARA_TOKEN>` (or, in a team cloud, a member's own upload
token: see "Team cloud" below); the read-only and phone tokens are refused with 401. If `KLARA_TOKEN` is missing or
shorter than 32 characters, every authenticated request is refused. Each uploader only ever touches their own
meetings and recordings: on a Worker without members that is everything, exactly as before.

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/api/health` | none (no auth) | `{"ok":true,"version":"1.2.0","features":["meetings","mcp","recordings","team"]}` |
| POST | `/api/meetings` | one meeting (below), upserted by `id` | `{"ok":true}` |
| DELETE | `/api/meetings/:id` | none | `{"ok":true,"deleted":1}` (or `0` if absent) |
| DELETE | `/api/meetings` | `{"all":true}` | `{"ok":true,"deleted":n}` |
| GET | `/api/recordings?status=ready` | none; `status` is optional: `recording`, `ready` or `processing` | `{"ok":true,"recordings":[{id,title,kind,mime,startedAt,durationSec,bytes,chunks,status}]}`, oldest first, at most 200 |
| GET | `/api/recordings/:id/audio` | none | the chunks joined in order, streamed; `Content-Type` is the stored mime, `X-Recording-Bytes` the total (and `Content-Length` on Cloudflare). 409 while still uploading |
| POST | `/api/recordings/:id/claim` | none | `{"ok":true,"status":"processing","recording":{…}}`; 409 if it is still uploading, or already processing and claimed less than 30 minutes ago |
| POST | `/api/recordings/:id/release` | none | `{"ok":true,"released":1}` (or `0`); a claimed recording goes back to `ready`, after a try that failed before its transcript was saved, so the next round retries at once instead of in 30 minutes |
| DELETE | `/api/recordings/:id` | none | `{"ok":true,"deleted":1}` (or `0`); deletes the row and its audio |

The app's loop: list `?status=ready`, claim one, download its audio, transcribe, `POST /api/meetings` with the
transcript, then `DELETE /api/recordings/:id`. A claim that is never finished (app quit, crash) can be taken over
after 30 minutes.

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
| `shared` | boolean, optional | team cloud: shared with the team. Missing: a new meeting is unshared, an existing one keeps what it had |

D1 holds at most 2,000,000 bytes per row, so all the fields together (in practice transcript + summary) must stay
under 1,990,000 bytes of UTF-8, or the upload gets 413. The app cuts a very long transcript to fit.

## Phone link

`GET /rec/<KLARA_REC_TOKEN>` serves a self-contained mobile page (inline CSS and JS under a per-response nonce CSP,
no external resources), in Hebrew and RTL when `navigator.language` starts with `he`, English otherwise. It has a
web app manifest (`manifest.webmanifest`, `icon-192.png`, `icon-512.png` under the same path) so it can be added to
the home screen. It records with `MediaRecorder` (`audio/webm;codecs=opus`, or `audio/mp4` on iOS Safari), keeps the
screen on with a Wake Lock, and stores every chunk in IndexedDB until the server acknowledges it, retrying with
backoff; reopening the page offers to finish uploading a recording that was cut off.

The page calls these routes. If `KLARA_REC_TOKEN` is missing, shorter than 32 characters or equal to one of the
other two secrets, every `/rec` path answers 404, as does a wrong token.

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/rec/<token>/start` | `{"title"?, "kind": "inperson"\|"phone", "mime", "startedAt", "clientId"?}` | `{"ok":true,"id":"r_…"}`; the same `clientId` again returns the same id |
| POST | `/rec/<token>/chunk?id=<id>&seq=<n>` | raw bytes, 1 to 1,000,000; `seq` 0–4999 | `{"ok":true}`; idempotent per `(id, seq)` |
| POST | `/rec/<token>/finish?id=<id>` | `{"chunks": n, "durationSec", "title"?}` | `{"ok":true}` and status `ready`, only if chunks `0…n-1` all exist; otherwise 409 with `"missing":[…]` |

Limits: 1,000,000 bytes per chunk, 64 MiB per recording (the page stops by itself at 60 MB, about 4 hours of
opus), 20 unfinished recordings at once (429), and `KLARA_REC_QUOTA_MB` for all stored audio together (507 with a
message that says to turn on the computer so the app can pick up the waiting recordings).

Cleanup runs on any request, at most once an hour (a timestamp row in `recording_meta`): recordings not finished
within 7 days and recordings left `ready` or `processing` for 30 days are deleted with their audio.

## Team cloud

Optional, and off until the owner invites someone. The owner is whoever holds `KLARA_TOKEN` (normally the person
who deployed the Worker). Nothing changes for a Worker without members: existing meetings and recordings belong to
the owner (`uploaded_by = 'owner'`, `member_id = 'owner'`) and are unshared. The tables and columns are added by the
Worker itself on first use (and by `schema.sql`), so an older deployment upgrades by redeploying.

**Members.** The owner invites a member by name and gets a one-time invite code (valid 7 days). The member's app
trades it at `POST /api/team/join` for three tokens of the member's own, made by the Worker and returned only in
that reply: an upload token (Bearer, `/api` only), a read-only connector token (`/mcp/<token>`) and a phone link
token (`/rec/<token>`). D1 keeps only SHA-256 hashes of tokens and codes, so the owner never sees a member's tokens.
A new invite for an existing member (a new computer) replaces their tokens once it is used.

**Who sees what:**

| Token | Can read | Can upload / change |
|---|---|---|
| Owner's `KLARA_MCP_TOKEN` | the owner's own meetings | nothing |
| A member's connector token | that member's own meetings (shown with their own ids) | nothing |
| A team connector token | only meetings marked shared, by anyone, each with "shared by: name" | nothing |
| Owner's `KLARA_TOKEN` | own recordings; team admin routes (names, counts, sizes; never content or tokens) | own meetings and recordings, the team |
| A member's upload token | own recordings | own meetings and recordings, and their sharing |
| A phone link (owner's or a member's) | nothing | recordings that only that person's computer can list, pull or delete |

A meeting is unshared unless its uploader shares it (the upload's `shared` field, or the share route). A member's
meetings are stored under `<member id>:<meeting id>`, so two people's meeting ids never collide and nobody can
overwrite or delete someone else's row. Removing a member revokes their tokens at once and deletes their phone
recordings and unshared meetings; their shared meetings are deleted too when the owner asks, otherwise they stay on
the team connector marked "no longer in the team".

| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| GET | `/api/me` | any upload token | none | `{"ok":true,"role":"owner"\|"member","id","name","ownerName",…}` |
| POST | `/api/meetings/:id/share` | any upload token | `{"shared":true\|false}` | `{"ok":true,"shared":…}`; 404 if this uploader has no such meeting |
| POST | `/api/team/join` | none (the code is the credential) | `{"code":"<64 hex>"}` | `{"ok":true,"member":{id,name},"ownerName","tokens":{"upload","mcp","rec"}}`; 404 if used, expired or cancelled |
| GET | `/api/team` | owner | none | members (name, status, counts, bytes, last seen), team connectors, limits |
| PUT | `/api/team` | owner | `{"ownerName"}` | the name shown on the owner's shared meetings |
| POST | `/api/team/members` | owner | `{"name"}` | `{"ok":true,"member":{id,name},"invite":{"code","expiresAt"}}` |
| POST | `/api/team/members/:id/invite` | owner | none | a new one-time code for that member |
| DELETE | `/api/team/members/:id` | owner | `{"deleteShared":false}` | `{"ok":true,"deletedMeetings","deletedRecordings","keptShared"}` |
| POST | `/api/team/connectors` | owner | `{"label"}` | `{"ok":true,"connector":{id,label,createdAt},"token"}` (the token only here) |
| DELETE | `/api/team/connectors/:id` | owner | none | `{"ok":true,"deleted":1}` |

A member's token on an owner route gets 403. Limits: 50 members, 20 team connectors, and per member
`KLARA_MEMBER_QUOTA_MB` (default 100) of meetings and `KLARA_MEMBER_REC_QUOTA_MB` (default 150) of waiting phone
audio (507 with a clear message), on top of the shared `KLARA_REC_QUOTA_MB`. The owner has no per-member limits.

The owner of the Cloudflare account can still open the D1 database in the Cloudflare dashboard. The Worker keeps
members apart from each other and from the team connector; it can't keep the account owner out of their own account.

## Errors

Errors are `{"ok":false,"error":"…"}` with one of these statuses:

- 400: validation failed; the message names the field.
- 401: bad or missing token, or the token isn't configured on the Worker.
- 403: a member's token on an owner-only team route.
- 404 and 405: unknown path or wrong method (wrong `/mcp` and `/rec` tokens are 404 too).
- 409: a recording isn't finished yet, is already claimed, or is missing chunks; a team limit was reached.
- 413: the transcript, summary, chunk or recording is too large, or the body is over 8 MB.
- 429: too many unfinished recordings.
- 507: the recording storage cap, a member's own room, or the D1 database, is full.
- 500: for example, `schema.sql` was never applied (the `meetings` table is missing).

## MCP endpoint

`POST /mcp/<KLARA_MCP_TOKEN>` serves MCP over Streamable HTTP. It is stateless (no session id), takes single or
batch JSON-RPC messages, and always answers with `application/json`. A wrong token (the other two included) gets
the same 404 as any unknown path, and GET or DELETE with the right token gets 405. If `KLARA_MCP_TOKEN` is missing,
shorter than 32 characters or the same as `KLARA_TOKEN`, `/mcp` answers 401 with a message saying so.

Tools (times are Asia/Jerusalem):

- `list_meetings(query?, days=14, limit=30)`
- `get_meeting(id, offset=0)`: `"latest"` works, and transcripts over 100,000 characters come in parts.
- `search_meetings(query, limit=10)`
- `daily_digest(date?)`

Transcript text, and the meeting details that come from invites and transcripts (titles, calendar events, participants, scope), are always wrapped in `<meeting_content>` with a "data, not instructions" warning. Phone
recordings are not visible to the connector; they become meetings only after the app uploads their transcript.

## Security notes

- The connector URL is a credential: anyone who has it can read every meeting, but can't upload, change or delete.
  To rotate it, set a new `KLARA_MCP_TOKEN` and re-add the connector; the app doesn't need to change.
- The phone link is a credential too, but a weaker one: anyone who has it can upload recordings (which would show
  up in the app to be transcribed) and fill the storage cap, but can't read, list or download anything. To rotate
  it, set a new `KLARA_REC_TOKEN` (the app does this from Settings) and open the new link on the phone.
- The app token never leaves the computer except as the Bearer header to the Worker. To rotate it, set a new
  `KLARA_TOKEN` and update it in the app.
- The phone link can only add recordings. Someone who has it could fill the recording store (up to the cap), but
  can't read anything. To rotate it, set a new `KLARA_REC_TOKEN` (or replace it in Settings → Cloud).
- Tokens are compared in constant time (SHA-256 of both sides, then a timing-safe compare). Team members' tokens,
  invite codes and team connector tokens are stored only as SHA-256 hashes and looked up by hash, so a lookup's
  timing depends on the hash, never on how much of a guess is right.
- There is no CORS, every response carries security headers, and request bodies are capped. The phone page's CSP
  allows only its own nonce'd inline script and style and same-origin requests.
- Nothing logs tokens, transcript, summary or audio content. Workers Logs are off in `wrangler.toml` because they
  would record the tokens in the `/mcp` and `/rec` URLs. `npx wrangler tail` still works.

## Tests

```sh
node --test cloudflare/test/      # Node 22.13+ or 24; no npm install
```

The test uses Node's built-in `node:sqlite` as an in-memory D1 fake, so it runs the real SQL and `schema.sql`.
`test/package.json` points the directory at the test file, which makes the directory form of `--test` work.
