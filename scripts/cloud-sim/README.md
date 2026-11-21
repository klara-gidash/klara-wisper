# Cloudflare simulation

These scripts test the optional Cloudflare pieces end to end without a Cloudflare account. They use the real
Worker runtime (`wrangler dev`, which runs workerd with a local D1), a real Chrome as the phone, and the app's
own TypeScript modules.

```sh
bash scripts/cloud-sim/run.sh            # everything, about 6 minutes
bash scripts/cloud-sim/run.sh routes     # one part: routes, deploy, phone or pull
```

What you need:

- The repo's `node_modules`, after `npm install`. The scripts use `typescript`, `electron` and `playwright-core`
  from there.
- Google Chrome in `/Applications`, or another path in `CHROME_PATH`. Only `phone` uses it.
- `afconvert`, which comes with macOS. `pull` uses it to make an AAC test file.
- On the first run, `run.sh` installs `wrangler@4` into a temp folder (`CLOUD_SIM_DEPS`, by default
  `$TMPDIR/klara-cloud-sim-deps`). It is never added to the app.

Everything runs in temp folders. Nothing touches the app's data, its settings or the installed app. Electron runs
with a temp `userData` folder, and wrangler writes its logs to a temp folder.

| Script | What it checks |
|---|---|
| `routes.mjs` | Every Worker route in `wrangler dev`: meeting upload and validation; keeping the three tokens apart; MCP `initialize`, `tools/list` and every tool (Hebrew search, `latest`, SQL injection attempts, batches); a 1.9 MB Hebrew transcript read back in parts and byte-exact; the 2 MB row limit; recordings (start, chunk, finish, list, claim, audio, delete); idempotency; byte-exact BLOB round trips, a 30 MB one included; the storage cap, also with concurrent chunks; the open-recordings limit; the page's CSP; an old v0.1.3 database upgraded by the Worker alone; no schema at all |
| `deploy.mjs` | `deployGateway` (src/main/cloudflareApi.ts) against `mock-cloudflare.mjs`, which stands in for Cloudflare's REST API and checks request shapes against its API reference. The uploaded `worker.js` really runs in `wrangler dev` with the uploaded secrets, and the address the app computes must answer. It covers token errors (unknown, expired, no account, several accounts, missing D1 permission, a key from another account), a fresh account (the first subdomain name taken), an existing database and subdomain, an account-owned token, slow DNS, a health check that never answers, setup run again (`workerExists`), update keeping the tokens, phone-link rotation, replacing all tokens, and a failure after the upload (the tokens were already saved) |
| `phone.mjs` | The `/rec/<token>` page in Chrome (Playwright) with a fake microphone playing `engine/tests/audio/conversation.wav`, in a phone viewport. It records about 32 s in Hebrew with the network cut for 14 s (the parts wait in IndexedDB, then upload). It closes a tab mid-recording while offline, then reopens it and uses the "finish uploading" banner. It checks the English UI, an iPhone-style `audio/mp4` recording (webm refused), and that a wrong link gets 404. It also checks for CSP violations and page errors. The recordings and a screenshot are saved to `CLOUD_SIM_OUT` |
| `pull.mjs` | Runs the app's real decoder (`src/main/audioDecode.ts`, in the repo's Electron) on Chrome webm/opus, a cut-off webm, Chrome fragmented mp4 and AAC m4a, plus garbage, a timeout and a crashed decoder page. Then it runs the full phone → meeting path: `RecordingsPuller` makes real HTTP calls to `wrangler dev` (the same calls as `phoneRecordings.ts`), the upload goes through `cloudPayload.ts`, and the result is read back through the MCP connector. It injects a failure at each step, deletes a meeting while its cleanup is pending, has two computers pull at once, uses an out-of-date token, and tests an older Worker without `/release` |

To see a regression test fail against an older Worker, point `CLOUD_SIM_WORKER` at another `worker.js`, for
example `git show 035fe3d:cloudflare/src/worker.js > /tmp/old.js; CLOUD_SIM_WORKER=/tmp/old.js bash
scripts/cloud-sim/run.sh phone`. That run fails the two-tab case.

What it can't simulate:

- Real Cloudflare limits: D1's 2,000,000-byte row limit, query and subrequest limits, CPU time. The Worker checks
  the row size itself, and `routes.mjs` checks that it does.
- workers.dev DNS and TLS. The mock's fetch maps `*.workers.dev` to `wrangler dev`.
- Cloudflare's exact error codes and messages, such as a taken subdomain. The mock uses plausible ones, and
  `cloudflareApi.ts` matches on words as well as codes.
- iOS Safari's MediaRecorder. The `audio/mp4` case uses Chrome's mp4 recorder instead.
- The speech engine. `pull.mjs` replaces transcription with a stub that reports how much audio was decoded.
