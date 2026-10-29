import { buildEmail, buildSms, extractCall } from "./summary.js";
import { sendEmail, sendSms } from "./senders.js";

// Minimal structured log: conversation ID, time, outcome. Never transcript
// text, names, phone numbers or message bodies.
export function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

const inFlight = new Set();

// Returns { httpStatus, result } for one verified webhook payload.
export async function handleEvent(payload, { config, store, fetchImpl = fetch }) {
  const type = payload?.type;
  const conversationId = payload?.data?.conversation_id;
  const agentId = payload?.data?.agent_id;

  if (agentId !== config.agentId) {
    // Other agents in the workspace (e.g. PlugSpeak) are never relayed.
    log("ignored_other_agent", { conversation_id: conversationId, type });
    return { httpStatus: 200, result: "ignored: other agent" };
  }
  if (type !== "post_call_transcription") {
    log("ignored_event_type", { conversation_id: conversationId, type });
    return { httpStatus: 200, result: `ignored: ${type}` };
  }
  if (typeof conversationId !== "string" || !conversationId) {
    log("rejected_no_conversation_id");
    return { httpStatus: 400, result: "missing conversation_id" };
  }
  if (inFlight.has(conversationId)) {
    log("duplicate_in_flight", { conversation_id: conversationId });
    return { httpStatus: 200, result: "duplicate: already processing" };
  }

  inFlight.add(conversationId);
  try {
    const call = extractCall(payload);
    const prev = store.get(conversationId) ?? {};

    // Email first, so the SMS can truthfully say whether details were emailed.
    const emailState = await deliver(conversationId, "email", prev.email, config.email, store, () =>
      sendEmail(config.email, buildEmail(call), `post-call-${conversationId}`, fetchImpl),
    );
    const smsState = await deliver(conversationId, "sms", prev.sms, config.sms, store, () =>
      sendSms(config.sms, buildSms(call, emailState), fetchImpl),
    );

    log("processed", { conversation_id: conversationId, email: emailState, sms: smsState });
    const anyFailed = emailState === "failed" || smsState === "failed";
    // A failed send returns 500 so an ElevenLabs retry can try that channel
    // again; channels already sent are skipped, so there are no duplicates.
    return { httpStatus: anyFailed ? 500 : 200, result: { email: emailState, sms: smsState } };
  } finally {
    inFlight.delete(conversationId);
  }
}

async function deliver(conversationId, channel, prev, channelConfig, store, send) {
  if (prev?.status === "sent") return "sent";
  if (prev?.status === "sending") {
    log("send_state_unknown_not_retried", { conversation_id: conversationId, channel });
    return "unknown";
  }
  if (!channelConfig.configured) {
    store.setChannel(conversationId, channel, { status: "pending" });
    log("send_pending_not_configured", { conversation_id: conversationId, channel });
    return "pending";
  }

  store.setChannel(conversationId, channel, { status: "sending" });
  const res = await send();
  if (res.ok) {
    store.setChannel(conversationId, channel, { status: "sent", id: res.id });
    log("send_ok", { conversation_id: conversationId, channel, provider_id: res.id, provider_status: res.providerStatus });
    return "sent";
  }
  store.setChannel(conversationId, channel, { status: "failed", error: res.error });
  log("send_failed", { conversation_id: conversationId, channel, error: res.error });
  return "failed";
}
