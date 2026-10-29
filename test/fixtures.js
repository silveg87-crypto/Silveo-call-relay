// Fictional test data only.
export const AGENT_ID = "agent_test_silveo";
export const SECRET = "whsec_test_only";

export function transcriptionPayload(overrides = {}) {
  return {
    type: "post_call_transcription",
    event_timestamp: 1761750000,
    data: {
      agent_id: AGENT_ID,
      conversation_id: "conv_test_001",
      status: "done",
      transcript: [
        { role: "agent", message: "Hi, you've reached Silveo's AI assistant. How can I help?" },
        { role: "user", message: "Hi, this is Dana from Acme Plumbing. Is Silveo there?" },
        { role: "agent", message: "He's not available right now. I can take a message. What's it about?" },
        { role: "user", message: "The parts for the kitchen sink arrived, he needs to pick a day for install before Friday." },
        { role: "agent", message: "What's the best number to call you back?" },
        { role: "user", message: "555 0100." },
        { role: "agent", message: "Let me read that back: Dana from Acme Plumbing, parts arrived, pick an install day before Friday, callback 555 0100. Is that right?" },
        { role: "user", message: "Yes, that's right." },
      ],
      metadata: {
        start_time_unix_secs: 1761749800,
        call_duration_secs: 95,
        phone_call: { direction: "inbound", external_number: "+15550000100", agent_number: "+13502211417" },
      },
      analysis: {
        call_successful: "success",
        transcript_summary:
          "Dana from Acme Plumbing called to say the kitchen sink parts arrived. Silveo needs to choose an install day before Friday. Callback 555 0100.",
        call_summary_title: "Kitchen sink parts arrived",
        data_collection_results: {},
      },
      ...overrides,
    },
  };
}

export function baseConfig(overrides = {}) {
  return {
    problems: [],
    webhookSecret: SECRET,
    agentId: AGENT_ID,
    sms: {
      configured: true,
      accountSid: "ACtest",
      auth: { user: "SKtest", pass: "secret" },
      from: "+13502211417",
      to: "+15550009999",
    },
    email: { configured: true, apiKey: "re_test", from: "Assistant <a@example.com>", to: "silveg87@gmail.com" },
    ...overrides,
  };
}

// Fake fetch that records calls and answers per host.
export function fakeFetch({ twilio = "ok", resend = "ok" } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const isTwilio = url.startsWith("https://api.twilio.com/");
    const mode = isTwilio ? twilio : resend;
    if (mode === "throw") throw new TypeError("fetch failed");
    if (mode === "fail") {
      return new Response(JSON.stringify(isTwilio ? { code: 21610, message: "x" } : { name: "validation_error" }), { status: 400 });
    }
    return new Response(JSON.stringify(isTwilio ? { sid: "SM123", status: "queued" } : { id: "email_123" }), {
      status: isTwilio ? 201 : 200,
    });
  };
  impl.calls = calls;
  impl.count = (host) => calls.filter((c) => c.url.includes(host)).length;
  return impl;
}
