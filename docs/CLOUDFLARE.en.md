# Klara Wisper in the cloud: ask Claude from your phone, and record from your phone

## What it does

Normally Klara Wisper keeps everything on your computer, and Claude reads your calls through a local connection. That connection only works in Claude Desktop and Claude Code on the same computer, so Claude on your phone can't reach it.

The cloud is optional, and it stays off until you turn it on. It gives you two things:

1. **Ask Claude about your calls from your phone.** Klara Wisper uploads transcripts and summaries (text), and in claude.ai you add a connector that can only read them.
2. **A phone recording link.** A link you open on your phone, tap, and it records to the cloud. Good for an in-person meeting or a phone call on speaker when your computer isn't with you.

Everything lives in **your own private Cloudflare account**: a small database and a small server (a Worker). There is no shared server and no third party running it. Cloudflare's free plan is enough for personal use, and you don't need to enter a payment method.

## Automatic setup (recommended)

1. If you don't have a Cloudflare account, sign up for free at https://dash.cloudflare.com/sign-up and confirm your email.
2. In Klara Wisper: **Settings** → **Cloud** → **"Set up automatically"**.
3. Click the link the app shows. It opens Cloudflare with an **API token** whose permissions are already filled in (only what's needed to create the database and the Worker). Click **Continue to summary** → **Create Token**, and copy the token.
4. Paste the token into Klara Wisper and click **"Set up"**. The app creates the database and the Worker in your account, and generates all three tokens by itself (see "The three tokens" below).
5. At the end you'll see two things:
   - **The Claude connector URL**: add it in claude.ai (see "In claude.ai").
   - **The phone recording link**: open it on your phone (see "Recording from your phone"). You can scan the QR code next to it.
6. Click **"Sync all calls"** to upload the calls you already have. From then on every call uploads by itself after it's saved, and again when it changes (summary, name, participants).

You can delete the API token in Cloudflare after setup: the app doesn't need it to work. To update the Worker or replace the phone link later, create a new token from the same link and paste it (or tick “keep for updates” during setup).

**Setting up again** (on a second computer, or after "Disconnect this computer from the cloud"): if the account already has the Worker, the app stops and asks first. A new setup replaces all three tokens, so another computer that syncs with the Worker stops syncing, and you add the claude.ai connector and the phone link again. If this computer still has the tokens, choose "Update, keeping this computer’s keys" instead.

## The three tokens

- **Upload token**: only Klara Wisper on your computer uses it, to upload calls, download recordings and delete. It is stored encrypted on the computer and never leaves it, except to your Worker.
- **Read token**: part of the connector URL in claude.ai. It can only read calls.
- **Recording token**: part of the phone recording link. It can only upload recordings; it can't read or play anything.

## Recording from your phone

1. Open the recording link on your phone: Safari on iPhone, Chrome on Android.
2. Add it to your home screen: on iPhone **Share** → **Add to Home Screen**, on Android the ⋮ menu → **Add to Home screen**. It becomes an icon with a red dot, and recording is one tap.
3. Optionally type a title, and choose **In-person meeting** or **Phone call on speaker**.
4. Tap the big button. The first time, the phone asks to allow the microphone. While recording, the screen stays on and you see a timer and a level meter. **Keep the page open** until you stop.
5. Tap again to stop. When you see **"Uploaded ✓ — will be transcribed on your computer"**, you can close it.

What happens behind the scenes:

- The recording uploads in small pieces, about every 10 seconds. Each piece is first saved on the phone and deleted from it only after the cloud confirms it arrived. If the connection drops, recording continues and the pieces upload when the connection is back. If the page is closed midway, the next time you open it you'll see a **"Finish uploading"** button.
- The audio waits in your Cloudflare account until your computer is on and Klara Wisper is open. Then it downloads the audio, transcribes it **on your computer, with the same Hebrew model**, and **deletes it from the cloud**. What stays is the transcript, like any other call (and if sync is on, that is uploaded as text).
- A recording not finished within 7 days, or waiting for the computer for 30 days, is deleted from the cloud automatically.
- The cloud has room for about 400 MB of waiting audio (roughly 25 hours). If it fills up, the phone shows a message and keeps the recording until the computer picks up what's waiting.
- One recording can last up to about 4 hours. Then it stops by itself, and you can start a new one.

Tips:

- Keep the page in front. If you lock the phone or switch to another app, recording may stop (especially on iPhone). What was already recorded is not lost.
- **Phone call on speaker:** the recording phone has to hear the speaker. It works best when the call itself runs on another device (a second phone, a desk phone or a computer). On iPhone, a cellular call on the same phone may stop the recording.
- Get the link onto your phone privately: scan the QR code, or use AirDrop, or a message to yourself only. Don't post it to a group.

## Before you start: what you give up in privacy

- **Without the cloud**, transcripts and audio exist only on your computer. **With the cloud**, a copy of the transcripts is kept in your private Cloudflare account, and phone recordings are kept there until your computer transcribes them. Cloudflare encrypts data at rest, but it is still with a cloud provider.
- **The connector URL contains the read token.** With that URL anyone can read all your calls, with no other password. See the warning at the end.
- **Anyone with the recording link can upload recordings** to your account (but can't read or hear anything). Keep it private; you can replace it in Settings → Cloud.
- Other people speak in your calls. Before recording or uploading work calls to the cloud, make sure it fits your company's policy and what was agreed with the participants.
- When Claude reads a call, the content goes to Anthropic, exactly as with the local connection.
- You can stop at any time: turn the cloud off and delete the data (see below).

## In claude.ai

1. Open claude.ai in a browser on your computer → **Settings** → **Connectors** → **Add custom connector**.
2. Name it `Klara Wisper`, and for the URL paste the connector URL from Klara Wisper → **Settings** → **Cloud**. It looks like:

   ```
   https://klara-wisper-gateway.<subdomain>.workers.dev/mcp/<TOKEN>
   ```

   With manual setup, `<TOKEN>` is the **read token** (`KLARA_MCP_TOKEN`), not the upload token. Leave the advanced (OAuth) settings empty.
3. Click **Add**.
4. From then on the connector is also available in the Claude mobile app, on the same account. If Claude doesn't use it, check that it's turned on in the chat's tools menu.

**Organization accounts (Team or Enterprise):** only admins may be able to add a custom connector. A connector added at the organization level is available to everyone in the organization, and the read token is inside the URL, so anyone connected to it could read your calls. **Don't ask your admins to add the connector to the organization.** Use a personal Claude account instead, or check with IT first.

## Example questions from your phone

- "What happened in my calls today?"
- "What did we agree with David about the contract renewal?"
- "In which call did we talk about the marketing budget, and what was said?"
- "Which tasks are still open from this week's meetings?"
- "Can I get a short summary of the last call?"

## Replacing a token

Replace a token if you think it leaked, and now and then anyway. **The easy way:** Klara Wisper → **Settings** → **Cloud** has buttons to replace the connector URL and the recording link. The steps below are the manual way.

**If the recording link leaked** (recording token): run `openssl rand -hex 32`, then `npx wrangler secret put KLARA_REC_TOKEN` and paste it. The old link stops working immediately. Update the token in Klara Wisper and open the new link on your phone (and add it to the home screen again).

**If the connector URL leaked** (read token):
1. Run `openssl rand -hex 32` and keep the new token.
2. Run `npx wrangler secret put KLARA_MCP_TOKEN` and paste it. The old URL stops working right away.
3. In claude.ai, remove the old connector and add it again with the new URL.

**If the upload token leaked:**
1. Run `openssl rand -hex 32` and keep the new token.
2. Run `npx wrangler secret put KLARA_TOKEN` and paste it.
3. Update the token in Klara Wisper → Settings → Cloud.

## Deleting all data

First turn the cloud off in Klara Wisper, so calls don't upload again.

**To empty the database and keep the Worker**, run (with your real address and upload token):

```
curl -X DELETE https://klara-wisper-gateway.<subdomain>.workers.dev/api/meetings \
  -H "Authorization: Bearer <UPLOAD_TOKEN>" -H "Content-Type: application/json" -d '{"all":true}'
```

The answer is `{"ok":true,"deleted":…}` with the number of calls deleted. Phone recordings are deleted from the cloud by themselves once the computer transcribes them.

**To delete everything** (Worker, database, calls and recordings), delete the Worker `klara-wisper-gateway` (Workers & Pages) and the database `klara-wisper` (D1) at https://dash.cloudflare.com, or run from the `cloudflare` folder:

```
npx wrangler delete
npx wrangler d1 delete klara-wisper
```

Finally, remove the connector from claude.ai and the icon from your phone's home screen.

## Warning: don't share the connector URL

The read token is inside the connector URL, and with that URL **anyone can read all your calls**, with no other password (but can't upload, change or delete). So:

- Don't send it in chat or email.
- Don't show it while screen sharing.
- Don't keep it in a shared document.

If it leaked, replace the read token right away (see "Replacing a token").

**The recording link** is less sensitive: someone who has it can only upload recordings to your account, not read or hear anything. Still, keep it private, and if it leaked, replace it in Settings → Cloud.

Never put the upload token in any URL or share it. It lives only in Klara Wisper and your password manager.

## Advanced: manual setup with wrangler

Only if you don't want to use automatic setup. All commands run in Terminal, from the `cloudflare` folder of the Klara Wisper code (GitHub → Code → Download ZIP), and you need Node.js (the LTS version from https://nodejs.org). To enter the folder, type `cd` and a space, drag the folder into the Terminal window and press Enter.

### 1. Free Cloudflare account

Sign up for free at https://dash.cloudflare.com/sign-up and confirm your email.

### 2. Log in from Terminal

```
npx wrangler login
```

A browser opens; allow access. The first time, `npx` asks whether to install wrangler: answer `y`.

### 3. Create the database

```
npx wrangler d1 create klara-wisper
```

The output includes a line like `database_id = "1234abcd-…"`. Copy the value between the quotes, open `wrangler.toml` in a text editor, replace `REPLACE_WITH_YOUR_D1_ID` with it (only the text between the quotes), and save. If wrangler offers to add the setting to the file itself, answer `n`.

### 4. Create the tables

```
npx wrangler d1 execute klara-wisper --remote --file=schema.sql
```

If asked to confirm, answer `y`.

### 5. Create the three tokens

All three must be different:
- **Upload token** (`KLARA_TOKEN`): used only by Klara Wisper on your computer, to upload calls and to download and delete phone recordings.
- **Read token** (`KLARA_MCP_TOKEN`): goes in the connector URL in claude.ai; can only read.
- **Recording token** (`KLARA_REC_TOKEN`): goes in the phone recording link; can only upload recordings.

Run this three times and keep the three results somewhere safe (a password manager):

```
openssl rand -hex 32
```

Then run each of these and paste the matching token when asked:

```
npx wrangler secret put KLARA_TOKEN
npx wrangler secret put KLARA_MCP_TOKEN
npx wrangler secret put KLARA_REC_TOKEN
```

If wrangler asks whether to create a new Worker named `klara-wisper-gateway`, answer `y`. Each token must be at least 32 characters. A shorter token is refused, and if two tokens are the same, the connector or the recording link doesn't work.

### 6. Deploy

```
npx wrangler deploy
```

The end of the output shows an address like `https://klara-wisper-gateway.<subdomain>.workers.dev`: that's your Worker. To check it works, open that address with `/api/health` at the end. You should see `{"ok":true,"version":"1.1.0",…}`, ending with `"recordings"`.

### 7. Connect Klara Wisper

**Settings** → **Cloud** → **"Manual setup"**: paste the Worker address, the upload token and the recording token. The app checks the Worker answers, stores the tokens encrypted, and shows the connector URL and the recording link. The recording link is `https://klara-wisper-gateway.<subdomain>.workers.dev/rec/<recording token>`.

A Worker set up before the recording link existed upgrades by running `npx wrangler deploy` again: the recording tables are created by themselves on first use. You only need to add `KLARA_REC_TOKEN`.
