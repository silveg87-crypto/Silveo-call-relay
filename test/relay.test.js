import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, WEBHOOK_PATH } from "../src/server.js";
import { signPayload, verifySignature } from "../src/signature.js";
import { buildEmail, buildSms, extractCall } from "../src/summary.js";
import { loadConfig, EMAIL_TO } from "../src/config.js";
import { Store } from "../src/store.js";
import { SECRET, baseConfig, fakeFetch, transcriptionPayload } from "./fixtures.js";

function freshStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), "relay-")), "state.json"));
}

async function withServer(opts, fn) {
  const server = createApp(opts);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

function post(base, payload, { secret = SECRET, header } = {}) {
  const raw = JSON.stringify(payload);
  return fetch(`${base}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ElevenLabs-Signature": header ?? signPayload(raw, secret) },
    body: raw,
  });
}

test("signature: valid, tampered, wrong secret, stale, missing", () => {
  const raw = '{"a":1}';
  assert.equal(verifySignature(raw, signPayload(raw, SECRET), SECRET).ok, true);
  assert.equal(verifySignature('{"a":2}', signPayload(raw, SECRET), SECRET).ok, false);
  assert.equal(verifySignature(raw, signPayload(raw, "other"), SECRET).ok, false);
  const old = Math.floor(Date.now() / 1000) - 31 * 60;
  assert.equal(verifySignature(raw, signPayload(raw, SECRET, old), SECRET).reason, "timestamp too old");
  assert.equal(verifySignature(raw, undefined, SECRET).ok, false);
  assert.equal(verifySignature(raw, "t=abc,v0=zz", SECRET).ok, false);
});

test("rejects unsigned and invalid requests without sending anything", async () => {
  const f = fakeFetch();
  await withServer({ config: baseConfig(), store: freshStore(), fetchImpl: f }, async (base) => {
    const r1 = await fetch(`${base}${WEBHOOK_PATH}`, { method: "POST", body: "{}" });
    assert.equal(r1.status, 401);
    const r2 = await post(base, transcriptionPayload(), { secret: "wrong" });
    assert.equal(r2.status, 401);
  });
  assert.equal(f.calls.length, 0);
});

test("happy path sends exactly one email and one SMS to the fixed recipients", async () => {
  const f = fakeFetch();
  await withServer({ config: baseConfig(), store: freshStore(), fetchImpl: f }, async (base) => {
    const r = await post(base, transcriptionPayload());
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).result, { email: "sent", sms: "sent" });
  });
  assert.equal(f.count("twilio"), 1);
  assert.equal(f.count("resend"), 1);
  const sms = new URLSearchParams(f.calls.find((c) => c.url.includes("twilio")).init.body);
  assert.equal(sms.get("From"), "+13502211417");
  assert.equal(sms.get("To"), "+15550009999");
  assert.match(sms.get("Body"), /Full details emailed\./);
  const email = JSON.parse(f.calls.find((c) => c.url.includes("resend")).init.body);
  assert.deepEqual(email.to, ["silveg87@gmail.com"]);
});

test("retries of the same conversation do not send duplicates", async () => {
  const f = fakeFetch();
  const store = freshStore();
  await withServer({ config: baseConfig(), store, fetchImpl: f }, async (base) => {
    for (let i = 0; i < 3; i++) assert.equal((await post(base, transcriptionPayload())).status, 200);
    // Concurrent duplicate deliveries.
    const p = transcriptionPayload({ conversation_id: "conv_parallel" });
    await Promise.all([post(base, p), post(base, p), post(base, p)]);
  });
  assert.equal(f.count("twilio"), 2);
  assert.equal(f.count("resend"), 2);
});

test("a failed SMS is reported as failed (500) and only SMS is retried", async () => {
  const store = freshStore();
  const failing = fakeFetch({ twilio: "fail" });
  await withServer({ config: baseConfig(), store, fetchImpl: failing }, async (base) => {
    const r = await post(base, transcriptionPayload());
    assert.equal(r.status, 500);
    assert.deepEqual((await r.json()).result, { email: "sent", sms: "failed" });
  });
  const ok = fakeFetch();
  await withServer({ config: baseConfig(), store, fetchImpl: ok }, async (base) => {
    const r = await post(base, transcriptionPayload());
    assert.equal(r.status, 200);
  });
  assert.equal(ok.count("resend"), 0);
  assert.equal(ok.count("twilio"), 1);
});

test("network errors are failures, never success", async () => {
  const f = fakeFetch({ twilio: "throw", resend: "throw" });
  await withServer({ config: baseConfig(), store: freshStore(), fetchImpl: f }, async (base) => {
    const r = await post(base, transcriptionPayload());
    assert.deepEqual((await r.json()).result, { email: "failed", sms: "failed" });
  });
  const sms = new URLSearchParams(f.calls.find((c) => c.url.includes("twilio")).init.body);
  assert.match(sms.get("Body"), /Email FAILED/);
});

test("email not configured: SMS still sent and marks email pending", async () => {
  const f = fakeFetch();
  const config = baseConfig({ email: { configured: false, reason: "x" } });
  await withServer({ config, store: freshStore(), fetchImpl: f }, async (base) => {
    const r = await post(base, transcriptionPayload());
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).result, { email: "pending", sms: "sent" });
  });
  assert.equal(f.count("resend"), 0);
  const sms = new URLSearchParams(f.calls[0].init.body);
  assert.match(sms.get("Body"), /Email pending/);
  assert.doesNotMatch(sms.get("Body"), /emailed/);
});

test("other agents (e.g. PlugSpeak) and non-transcript events are ignored", async () => {
  const f = fakeFetch();
  await withServer({ config: baseConfig(), store: freshStore(), fetchImpl: f }, async (base) => {
    const other = transcriptionPayload({ agent_id: "8PI4cg5C0aywFYdJwJEe" });
    assert.equal((await post(base, other)).status, 200);
    const audio = { type: "post_call_audio", data: { agent_id: "agent_test_silveo", conversation_id: "c", full_audio: "AA" } };
    assert.equal((await post(base, audio)).status, 200);
    const fail = { type: "call_initiation_failure", data: { agent_id: "agent_test_silveo", conversation_id: "c2" } };
    assert.equal((await post(base, fail)).status, 200);
  });
  assert.equal(f.calls.length, 0);
});

test("SMS is concise, GSM-safe, labeled, and honest about the callback", () => {
  const call = extractCall(transcriptionPayload());
  const sms = buildSms(call, "sent");
  assert.ok(sms.length <= 306, `sms is ${sms.length} chars`);
  assert.match(sms, /^Phone assistant - Inbound call with unknown caller/);
  assert.match(sms, /Callback: not given \(caller ID \+15550000100\)/);
  assert.match(sms, /Dana from Acme Plumbing called/);
  assert.match(sms, /^[\x0A\x20-\x5A\x5F\x61-\x7A]*$/);
});

test("data-collection fields, when present, are used", () => {
  const p = transcriptionPayload();
  p.data.analysis.data_collection_results = {
    caller_name: { value: "Dana" },
    callback_number: { value: "+15550000100" },
    urgency: { value: "before Friday" },
    reason: { value: "none" },
  };
  const call = extractCall(p);
  const sms = buildSms(call, "sent");
  assert.match(sms, /with Dana\n/);
  assert.match(sms, /Callback: \+15550000100/);
  assert.match(sms, /Urgent: before Friday/);
  assert.match(sms, /Dana from Acme Plumbing called/); // "none" falls back to the summary
});

test("email is labeled, lists unconfirmed fields, flags asks for Silveo, includes IDs", () => {
  const { subject, text } = buildEmail(extractCall(transcriptionPayload()));
  assert.match(subject, /^Phone assistant: unknown caller - Dana from Acme Plumbing called/);
  assert.match(text, /written automatically by Silveo's AI phone assistant, not by Silveo/);
  assert.match(text, /caller replied: "Yes, that's right\."/);
  assert.match(text, /Not captured as a confirmed field: caller name, callback number/);
  assert.match(text, /asked to speak with Silveo directly/);
  assert.match(text, /Conversation ID: conv_test_001/);
  assert.match(text, /Caller: Hi, this is Dana from Acme Plumbing/);
});

test("no read-back means details are marked NOT confirmed", () => {
  const p = transcriptionPayload();
  p.data.transcript = p.data.transcript.slice(0, 6);
  assert.match(buildEmail(extractCall(p)).text, /No read-back was found.*NOT confirmed/);
});

test("config: email recipient is fixed; bad numbers rejected; secrets required", () => {
  assert.equal(EMAIL_TO, "silveg87@gmail.com");
  const c = loadConfig({});
  assert.ok(c.problems.some((p) => p.includes("ELEVENLABS_WEBHOOK_SECRET")));
  assert.equal(c.sms.configured, false);
  assert.equal(c.email.configured, false);
  const bad = loadConfig({ ELEVENLABS_WEBHOOK_SECRET: "s", ELEVENLABS_AGENT_ID: "a", SILVEO_SMS_TO: "5551234" });
  assert.ok(bad.problems.some((p) => p.includes("E.164")));
  const self = loadConfig({ ELEVENLABS_WEBHOOK_SECRET: "s", ELEVENLABS_AGENT_ID: "a", SILVEO_SMS_TO: "+13502211417" });
  assert.ok(self.problems.some((p) => p.includes("own number")));
  const ok = loadConfig({
    ELEVENLABS_WEBHOOK_SECRET: "s",
    ELEVENLABS_AGENT_ID: "a",
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_API_KEY_SID: "SK1",
    TWILIO_API_KEY_SECRET: "x",
    SILVEO_SMS_TO: "+15550009999",
    EMAIL_TO: "attacker@example.com",
  });
  assert.equal(ok.sms.configured, true);
  assert.equal(ok.sms.from, "+13502211417");
  assert.equal(ok.email.configured, false);
});

test("short reasons stay in one SMS segment", () => {
  const p = transcriptionPayload();
  p.data.analysis.transcript_summary = "Package delivered to the side door.";
  const sms = buildSms(extractCall(p), "sent");
  assert.ok(sms.length <= 160, `sms is ${sms.length} chars`);
});
