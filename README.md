# Silveo Phone Assistant - Post-Call Relay

A small, standalone Node.js webhook receiver. When a call with the ElevenLabs
agent **"Silveo personal Ai assistant"** ends, ElevenLabs sends a post-call
webhook here. The relay verifies it and sends Silveo:

- **one SMS** (Twilio, from `+1 350 221 1417`) to Silveo's personal phone, and
- **one email** to `silveg87@gmail.com`.

> **This is not part of PlugSpeak.** It has its own `package.json`, no shared
> code, and no runtime dependencies. It does not touch PlugSpeak, the Lovable
> project, any PlugSpeak agent, or the template agent `8PI4cg5C0aywFYdJwJEe`.
> It lives in its own repository and must not be copied into the PlugSpeak /
> Lovable project.

It only **reports completed calls**. It never places calls, never sends SMS to
callers, and has no "message anyone" feature: the SMS recipient is one number
from an env var and the email recipient is hard-coded.

---

## What it does on each webhook

1. Reads the raw body and verifies the `ElevenLabs-Signature` header
   (`t=<unix>,v0=<HMAC-SHA256 hex of "<t>.<raw body>">`, 30-minute window -
   the same check as ElevenLabs' official SDK). Unsigned or invalid → `401`,
   nothing sent.
2. Ignores (with `200`) any event from another agent, and any event that is not
   `post_call_transcription` (audio, call-initiation failures).
3. Looks up the conversation ID in its state file. A channel already sent is
   **never sent again**, so ElevenLabs retries cannot cause duplicates.
4. Sends the email first, then the SMS (so the SMS can truthfully say
   "Full details emailed." / "Email pending" / "Email FAILED").
5. Records each channel as `sent` only when the provider API accepted it
   (Twilio returned a message SID / Resend returned an email ID).

| Situation | Result | HTTP to ElevenLabs |
|---|---|---|
| Both accepted | `sent` / `sent` | 200 |
| Email not configured yet | email `pending`, SMS still sent, SMS says "Email pending" | 200 |
| A provider rejects / times out | that channel `failed`, logged | 500 (so a retry can resend **only** the failed channel) |
| Same conversation delivered again | already-sent channels skipped | 200 |
| Crash between "start send" and "record result" | channel stays `sending`, treated as unknown and **not** resent (no duplicates), logged | 200 |

"SMS sent" means **Twilio accepted it** (status `queued`). Actual handset
delivery is shown in the Twilio console (Monitor → Logs → Messaging).

### What the summary contains

- **SMS** (one segment when the reason is short, never more than two):
  ```
  Phone assistant - Inbound call with unknown caller
  Dana from Acme Plumbing called to say the kitchen sink parts arrived.
  Callback: not given (caller ID +15550000100)
  Full details emailed.
  ```
  Plain ASCII on purpose: an em dash or curly quote switches SMS to UCS-2 and
  roughly doubles the cost.
- **Email** (subject `Phone assistant: <name> - <reason>`): a line saying it was
  written by Silveo's AI assistant (not Silveo) and contains no promises; caller,
  company, callback, caller ID, reason, urgency, follow-up; the ElevenLabs call
  summary; what was read back / confirmed and what was **not** confirmed;
  notes if the caller asked for Silveo directly or the assistant said it could
  not do something; conversation ID, start time, duration; full transcript.

Where the data comes from - nothing is invented:

- **Reason / summary**: ElevenLabs' own call analysis (`transcript_summary`).
- **Caller ID**: the phone network number in the webhook, clearly labeled as
  not confirmed by the caller.
- **Name, callback, urgency, follow-up, confirmation**: only if the agent has
  ElevenLabs *Data collection* fields named e.g. `caller_name`,
  `callback_number`, `reason`, `urgency`, `follow_up`, `details_confirmed`
  (see `src/summary.js` for the accepted names). **The agent does not have
  these today and this build does not add them** (that would be an agent
  change outside this brief). Without them those fields show "not given",
  and the email says so explicitly. The name usually still appears in the
  summary sentence. Adding them later is optional and needs Silveo's approval.
- **Read-back / "asked for Silveo" / "could not do"**: simple keyword checks on
  the transcript, always worded as "possible ... check transcript".

### Logs

One JSON line per event: time, event, conversation ID, channel, `sent` /
`failed` / `pending`, provider message ID, short error code (e.g.
`twilio_http_400_code_30034`). No transcript text, names, phone numbers or
message bodies are logged. The state file holds the same minimal data and
prunes entries after 30 days.

---

## Deploy

Requirements: Node.js 20+ and **persistent disk** for `STATE_FILE` (without it,
a restart forgets which conversations were sent and a later retry could
duplicate). No `npm install` is needed (zero dependencies).

Any host that runs a Node web service with a persistent volume and HTTPS
works, for example Render (web service + persistent disk), Railway (service +
volume) or Fly.io (app + volume). Silveo chooses the host.

- Root directory: repository root
- Start command: `npm start` (runs `node src/server.js`)
- Health check: `GET /healthz` → `{"ok":true,"sms":"configured","email":"pending"}`
- Webhook URL: `https://<your-host>/webhooks/elevenlabs/post-call`

Run the tests anywhere with `npm test`.

### Environment variables (host secret store only)

See `.env.example`. Never put values in code, chat, screenshots or the repo.

| Variable | Required | Notes |
|---|---|---|
| `ELEVENLABS_WEBHOOK_SECRET` | yes | Shown once when the webhook is created in ElevenLabs. |
| `ELEVENLABS_AGENT_ID` | yes | ID of "Silveo personal Ai assistant". Every other agent's events are ignored. |
| `TWILIO_ACCOUNT_SID` | for SMS | `AC...` |
| `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` | for SMS (preferred) | Twilio Console → Account → API keys → Create *Standard* key. Revocable without touching the Auth Token. |
| `TWILIO_AUTH_TOKEN` | alternative | Only if no API key is used. |
| `TWILIO_FROM_NUMBER` | no | Defaults to `+13502211417`. |
| `SILVEO_SMS_TO` | for SMS | Silveo's personal phone, E.164 (`+1XXXXXXXXXX`). Supplied by Silveo. |
| `RESEND_API_KEY` | for email | Leave empty until the sender is approved; email is then marked pending. |
| `EMAIL_FROM` | for email | e.g. `Silveo's AI assistant <onboarding@resend.dev>` |
| `PORT` | no | Default `8080` (most hosts set it). |
| `STATE_FILE` | no | Default `./data/state.json`; point it at the persistent volume. |

The server refuses to start if the ElevenLabs values are missing or a phone
number is malformed. It starts without SMS/email credentials so the webhook can
be wired up first, but `/healthz` and the startup log show what is missing.

### Email sender (needs Silveo's approval)

Implemented: **Resend** (transactional email API, API key only - no Gmail
password or app password).

- Simplest: create a Resend account **with `silveg87@gmail.com`**, create an
  API key with *Sending access* only, and use
  `EMAIL_FROM=Silveo's AI assistant <onboarding@resend.dev>`. Resend's test
  sender may only send to the account owner's own address, which is exactly
  the one recipient here.
- Optional: verify a domain Silveo owns in Resend and use an address on it.

If Silveo prefers another method (Gmail API with OAuth, another provider),
only `sendEmail` in `src/senders.js` needs replacing.

### Twilio SMS - read before deploy

`+1 350 221 1417` is a US local (10DLC) number. US carriers block SMS from
unregistered 10DLC numbers (Twilio error **30034**). Before SMS will deliver,
the number must be in an approved **A2P 10DLC** campaign (Twilio Console →
Messaging → Regulatory Compliance; a *Sole Proprietor* brand fits a single
person). This is outbound SMS to Silveo only - it does **not** enable inbound
SMS for callers (stays off) and does **not** enable outbound calling.

---

## ElevenLabs: the one setting to change

Only the post-call webhook for Silveo's agent. Nothing else on the agent, and
nothing on PlugSpeak agents or the workspace default.

1. ElevenLabs → **ElevenAgents** → workspace **Settings** → **Webhooks** →
   **Create webhook**. Name it `Silveo call relay`, URL
   `https://<your-host>/webhooks/elevenlabs/post-call`, auth **HMAC**.
   Copy the signing secret straight into the host's `ELEVENLABS_WEBHOOK_SECRET`.
   Creating a webhook here does not attach it to any agent.
2. **Do not** set it as the workspace-wide post-call webhook (that default
   applies to every agent, including PlugSpeak's). Leave the workspace default
   as it is.
3. ElevenAgents → **Agents** → **Silveo personal Ai assistant** → **Settings**
   → **Post-call webhooks** → choose `Silveo call relay` from the dropdown.
   If it asks which events, select **transcript only** (not audio).
   Save / publish the agent.
4. Copy the agent ID from the agent page into `ELEVENLABS_AGENT_ID`.

Optional hardening: restrict the host's firewall to ElevenLabs' published
egress IPs.

---

## Test plan

Before the real call (no phone needed):

1. `GET https://<host>/healthz` shows `sms: configured` (and `email:
   configured` if the sender is approved).
2. Unsigned request is rejected:
   `curl -i -X POST https://<host>/webhooks/elevenlabs/post-call -d '{}'` → `401`.
3. Signed self-test, sent twice:
   `RELAY_URL=https://<host>/webhooks/elevenlabs/post-call ELEVENLABS_WEBHOOK_SECRET=... ELEVENLABS_AGENT_ID=... node scripts/send-test-webhook.js`
   (run on the host or in a shell with the secrets; do not paste them in chat).
   Expect exactly **one** SMS and **one** email marked "RELAY SELF-TEST", and
   the second attempt returning `200` with no new sends.

The real call:

4. From any phone, make **one** direct call to `+1 350 221 1417`. Leave a short
   message with a name, callback number and reason; let the assistant read it
   back; hang up.
5. Within a few minutes, verify:
   - **(a) SMS received** on Silveo's phone, from `+1 350 221 1417`, labeled
     "Phone assistant". If not: relay log `send_ok`/`send_failed` for that
     conversation, then Twilio → Monitor → Logs → Messaging (30034 = 10DLC not
     registered).
   - **(b) Email received** at `silveg87@gmail.com` (check Spam the first
     time). If email is not configured, the SMS must say "Email pending".
   - **(c) Summary matches the transcript**: compare the email with the
     conversation in ElevenLabs → Conversations (same conversation ID). Nothing
     in the SMS/email may be absent from the transcript; unconfirmed fields
     must say "not given" / "NOT confirmed".
   - **(d) No duplicates on retry**: step 3 already delivered the same
     conversation twice and proved the second delivery sends nothing. For the
     real call, the relay logs must show exactly one `send_ok` for `email` and
     one for `sms` with that conversation ID, even if ElevenLabs delivered the
     webhook more than once; and only one SMS/email arrives.
6. Make sure no PlugSpeak call produced an SMS/email (relay logs show
   `ignored_other_agent` at most).

---

## Still needed from Silveo before deploy

1. **Hosting choice** (Node 20 service with a persistent volume and HTTPS).
2. **Silveo's personal phone number** for `SILVEO_SMS_TO`, entered by Silveo
   directly into the host's secret store.
3. **Twilio credentials** (Standard API key preferred) entered into the secret
   store, and **A2P 10DLC registration** for `+1 350 221 1417` (or SMS will be
   blocked).
4. **Email sender approval**: Resend as described above (or another method).
   Until then SMS works and email is marked pending.
5. **ElevenLabs**: create the webhook, copy its secret into the host, select it
   on Silveo's agent only, and provide the agent ID.
6. Optional, separate approval: add Data collection fields to the agent for a
   richer name/callback/urgency line. Not part of this build.

Out of scope and untouched: PlugSpeak, Lovable, Verizon/porting/forwarding,
inbound caller SMS, outbound calling, and the still-open outbound
greeting/prompt issue.
