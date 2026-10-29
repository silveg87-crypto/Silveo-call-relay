// Builds the SMS and email text from an ElevenLabs post_call_transcription
// payload. It only restates what the payload contains: ElevenLabs' own call
// analysis, optional data-collection fields, the caller ID and the transcript.
// It never adds promises, appointments, prices or agreements.

const LABEL = "Silveo's AI phone assistant";

// Optional ElevenLabs "Data collection" field names this relay understands.
// None of these exist unless Silveo chooses to add them to the agent later;
// without them the relay falls back to the ElevenLabs summary + transcript.
const FIELD_ALIASES = {
  name: ["caller_name", "name", "caller"],
  company: ["caller_company", "company"],
  callback: ["callback_number", "callback", "phone_number"],
  reason: ["reason", "call_reason", "message_reason"],
  details: ["message", "details", "message_details"],
  urgency: ["urgency", "deadline", "urgency_deadline"],
  followUp: ["follow_up", "requested_follow_up", "followup"],
  confirmed: ["details_confirmed", "read_back_confirmed", "confirmed"],
};

function collected(data, key) {
  const results = data?.analysis?.data_collection_results ?? {};
  for (const alias of FIELD_ALIASES[key]) {
    const v = results[alias]?.value;
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s && !/^(none|null|n\/a|unknown|not (given|provided|stated))$/i.test(s)) return s;
  }
  return undefined;
}

function oneLine(s, max) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 3).trimEnd() + "..." : flat;
}

function firstSentence(s) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : flat;
}

function callerId(data) {
  return (
    data?.metadata?.phone_call?.external_number ??
    data?.conversation_initiation_client_data?.dynamic_variables?.system__caller_id ??
    undefined
  );
}

function direction(data) {
  const d = String(
    data?.metadata?.phone_call?.direction ??
      data?.conversation_initiation_client_data?.dynamic_variables?.system__call_direction ??
      "",
  ).toLowerCase();
  if (d === "inbound") return "Inbound";
  if (d === "outbound") return "Outbound";
  return undefined;
}

// Keyword checks are flagged as "possible" and always point to the transcript.
const ASKED_FOR_SILVEO =
  /\b(speak|talk) (to|with) silveo\b|\bis silveo (there|available|in)\b|\bput me through\b|\btransfer me\b|\bspeak to (a|the) (real )?(person|human)\b/i;
const AGENT_COULD_NOT =
  /\b(i (can(no|')t|am not able to|'m not able to|am unable to)|unable to)\b/i;
const READ_BACK = /\b(read (that|it|this|your message) back|let me (confirm|repeat)|to confirm|confirm(ing)? (that|your|the))\b/i;
const AFFIRM = /^\s*(yes|yeah|yep|correct|that'?s (right|correct)|right|exactly|perfect)\b/i;

function scanTranscript(transcript) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const flags = { askedForSilveo: false, agentCouldNot: false, readBack: undefined };
  for (let i = 0; i < turns.length; i++) {
    const { role, message } = turns[i] ?? {};
    if (typeof message !== "string") continue;
    if (role === "user" && ASKED_FOR_SILVEO.test(message)) flags.askedForSilveo = true;
    if (role === "agent" && AGENT_COULD_NOT.test(message)) flags.agentCouldNot = true;
    if (role === "agent" && READ_BACK.test(message)) {
      const reply = turns.slice(i + 1).find((t) => t?.role === "user" && typeof t.message === "string");
      flags.readBack = { affirmed: Boolean(reply && AFFIRM.test(reply.message)), reply: reply?.message };
    }
  }
  return flags;
}

export function extractCall(payload) {
  const data = payload?.data ?? {};
  const analysis = data.analysis ?? {};
  const summary = typeof analysis.transcript_summary === "string" ? analysis.transcript_summary.trim() : "";
  const title = typeof analysis.call_summary_title === "string" ? analysis.call_summary_title.trim() : "";
  const startSecs = Number(data.metadata?.start_time_unix_secs);
  return {
    conversationId: data.conversation_id,
    direction: direction(data),
    name: collected(data, "name"),
    company: collected(data, "company"),
    callback: collected(data, "callback"),
    callerId: callerId(data),
    reason: collected(data, "reason") ?? (firstSentence(summary) || title || undefined),
    details: collected(data, "details"),
    urgency: collected(data, "urgency"),
    followUp: collected(data, "followUp"),
    confirmed: collected(data, "confirmed"),
    summary,
    startedAt: Number.isFinite(startSecs) && startSecs > 0 ? new Date(startSecs * 1000) : undefined,
    durationSecs: Number(data.metadata?.call_duration_secs) || undefined,
    status: data.status,
    transcript: Array.isArray(data.transcript) ? data.transcript : [],
    flags: scanTranscript(data.transcript),
  };
}

// Replace characters outside the basic GSM-7 set so the SMS is not forced into
// UCS-2 (70 chars/segment), which would multiply the cost.
function gsmSafe(s) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x0A\x0D\x20-\x5A\x5F\x61-\x7A]/g, (c) => c.normalize("NFKD").replace(/[^\x20-\x5A\x5F\x61-\x7A]/g, ""));
}

const SMS_TARGET = 160;

export function buildSms(call, emailStatus) {
  const who = call.name ? oneLine(call.name, 40) : "unknown caller";
  const header = `Phone assistant - ${call.direction ? call.direction + " call" : "Call"} with ${who}`;
  const callback = call.callback
    ? `Callback: ${call.callback}`
    : call.callerId
      ? `Callback: not given (caller ID ${call.callerId})`
      : "Callback: not given";
  const urgency = call.urgency ? `Urgent: ${oneLine(call.urgency, 60)}` : undefined;
  const footer =
    emailStatus === "sent"
      ? "Full details emailed."
      : emailStatus === "failed"
        ? "Email FAILED - check relay."
        : emailStatus === "pending"
          ? "Email pending (not set up)."
          : "Email status unknown - check relay.";

  const fixed = [header, callback, urgency, footer].filter(Boolean);
  const fixedLen = gsmSafe(fixed.join("\n")).length + 1;
  // One segment when the reason fits; otherwise allow a second segment rather
  // than cutting the reason to a few words. Never more than two.
  const room = SMS_TARGET - fixedLen;
  const fullReason = oneLine(call.reason || "Reason not stated - see email", 1000);
  const reason = oneLine(fullReason, gsmSafe(fullReason).length <= room ? room : 120);
  const text = gsmSafe([header, reason, callback, urgency, footer].filter(Boolean).join("\n"));
  return text.length > 306 ? text.slice(0, 303) + "..." : text;
}

function fmtTime(d) {
  if (!d) return "unknown";
  return `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function buildEmail(call) {
  const who = call.name ?? "unknown caller";
  const subject = oneLine(`Phone assistant: ${who} - ${call.reason || "call summary"}`, 140);
  const v = (x, fallback = "not given") => (x ? x : fallback);

  const notConfirmed = [];
  if (!call.name) notConfirmed.push("caller name");
  if (!call.callback) notConfirmed.push("callback number");
  if (!call.reason) notConfirmed.push("reason for the call");
  if (!call.urgency) notConfirmed.push("urgency / deadline");
  if (!call.followUp) notConfirmed.push("requested follow-up");

  let readBack;
  if (call.confirmed) readBack = `Caller confirmation (from call analysis): ${call.confirmed}`;
  else if (call.flags.readBack?.affirmed)
    readBack = `The assistant read details back and the caller replied: "${oneLine(call.flags.readBack.reply, 160)}" (automatic check - verify in transcript).`;
  else if (call.flags.readBack)
    readBack = "The assistant attempted a read-back, but no clear confirmation from the caller was found. Treat the details as NOT confirmed.";
  else readBack = "No read-back was found in the transcript. Treat the details as NOT confirmed.";

  const notes = [];
  if (call.flags.askedForSilveo) notes.push("- Possible: the caller asked to speak with Silveo directly (keyword match - check transcript).");
  if (call.flags.agentCouldNot) notes.push("- Possible: the assistant told the caller it could not do something (keyword match - check transcript).");
  if (!call.direction) notes.push("- Call direction was not included in the webhook.");

  const transcript = call.transcript
    .filter((t) => typeof t?.message === "string" && t.message.trim())
    .map((t) => `${t.role === "agent" ? "Assistant" : t.role === "user" ? "Caller" : t.role}: ${t.message.trim()}`)
    .join("\n");

  const text = [
    `This summary was written automatically by ${LABEL}, not by Silveo.`,
    `It only reports what was said on the call. Nothing here is a promise, appointment, price or agreement unless the caller and assistant explicitly confirmed it in the transcript below.`,
    "",
    "CALL",
    `Direction: ${v(call.direction, "unknown")}`,
    `Caller: ${who}${call.company ? ` (${call.company})` : ""}`,
    `Callback number given: ${v(call.callback)}`,
    `Caller ID (from the phone network, not confirmed by caller): ${v(call.callerId, "not available")}`,
    `Reason: ${v(call.reason, "not stated")}`,
    `Urgency / deadline: ${v(call.urgency, "none stated")}`,
    `Requested follow-up: ${v(call.followUp, "none stated")}`,
    ...(call.details ? [`Details: ${call.details}`] : []),
    "",
    "SUMMARY (generated by ElevenLabs call analysis)",
    call.summary || "No summary was provided by ElevenLabs. See the transcript.",
    "",
    "CONFIRMATION",
    readBack,
    notConfirmed.length ? `Not captured as a confirmed field: ${notConfirmed.join(", ")}.` : "All key fields were captured.",
    ...(notes.length ? ["", "NOTES", ...notes] : []),
    "",
    "REFERENCE",
    `Conversation ID: ${v(call.conversationId, "unknown")}`,
    `Started: ${fmtTime(call.startedAt)}`,
    `Duration: ${call.durationSecs ? `${call.durationSecs}s` : "unknown"}`,
    "",
    "TRANSCRIPT",
    transcript || "(empty)",
  ].join("\n");

  return { subject, text };
}
