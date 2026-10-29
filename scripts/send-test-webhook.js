// Sends one signed, clearly fictional post-call webhook to a running relay,
// then repeats it to prove no duplicate SMS/email is sent.
//   RELAY_URL=https://<host>/webhooks/elevenlabs/post-call \
//   ELEVENLABS_WEBHOOK_SECRET=... ELEVENLABS_AGENT_ID=... node scripts/send-test-webhook.js
import { signPayload } from "../src/signature.js";

const url = process.env.RELAY_URL;
const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
const agentId = process.env.ELEVENLABS_AGENT_ID;
if (!url || !secret || !agentId) {
  console.error("Set RELAY_URL, ELEVENLABS_WEBHOOK_SECRET and ELEVENLABS_AGENT_ID.");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  type: "post_call_transcription",
  event_timestamp: now,
  data: {
    agent_id: agentId,
    conversation_id: `relay_selftest_${now}`,
    status: "done",
    transcript: [
      { role: "agent", message: "Hi, this is Silveo's AI assistant. How can I help?" },
      { role: "user", message: "This is a relay self-test. No action needed." },
      { role: "agent", message: "Let me read that back: relay self-test, no action needed. Is that right?" },
      { role: "user", message: "Yes." },
    ],
    metadata: { start_time_unix_secs: now - 60, call_duration_secs: 60, phone_call: { direction: "inbound" } },
    analysis: { transcript_summary: "RELAY SELF-TEST - not a real call. No action needed." },
  },
};

for (const attempt of [1, 2]) {
  const raw = JSON.stringify(payload);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ElevenLabs-Signature": signPayload(raw, secret) },
    body: raw,
  });
  console.log(`attempt ${attempt}: HTTP ${res.status}`, await res.text());
}
console.log("Expect exactly one SMS and one email for", payload.data.conversation_id);
