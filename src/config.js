// All secrets come from environment variables. Nothing secret is hard-coded.

// The only email recipient this relay will ever use. Deliberately not
// configurable so a misconfigured env var cannot redirect call details.
export const EMAIL_TO = "silveg87@gmail.com";

export const DEFAULT_SMS_FROM = "+13502211417";

const E164 = /^\+[1-9]\d{7,14}$/;

function clean(value) {
  const v = (value ?? "").trim();
  return v === "" ? undefined : v;
}

export function loadConfig(env = process.env) {
  const problems = [];

  const webhookSecret = clean(env.ELEVENLABS_WEBHOOK_SECRET);
  const agentId = clean(env.ELEVENLABS_AGENT_ID);
  if (!webhookSecret) problems.push("ELEVENLABS_WEBHOOK_SECRET is required");
  if (!agentId) problems.push("ELEVENLABS_AGENT_ID is required");

  // --- SMS (Twilio) ---
  const accountSid = clean(env.TWILIO_ACCOUNT_SID);
  const apiKeySid = clean(env.TWILIO_API_KEY_SID);
  const apiKeySecret = clean(env.TWILIO_API_KEY_SECRET);
  const authToken = clean(env.TWILIO_AUTH_TOKEN);
  const smsFrom = clean(env.TWILIO_FROM_NUMBER) ?? DEFAULT_SMS_FROM;
  const smsTo = clean(env.SILVEO_SMS_TO);

  let sms = { configured: false, reason: "SMS not configured" };
  const auth =
    apiKeySid && apiKeySecret
      ? { user: apiKeySid, pass: apiKeySecret }
      : authToken && accountSid
        ? { user: accountSid, pass: authToken }
        : undefined;
  if (smsTo && !E164.test(smsTo)) {
    problems.push("SILVEO_SMS_TO must be E.164, e.g. +1XXXXXXXXXX");
  } else if (!E164.test(smsFrom)) {
    problems.push("TWILIO_FROM_NUMBER must be E.164");
  } else if (smsTo && smsTo === smsFrom) {
    problems.push("SILVEO_SMS_TO must not be the assistant's own number");
  } else if (accountSid && auth && smsTo) {
    sms = { configured: true, accountSid, auth, from: smsFrom, to: smsTo };
  } else {
    const missing = [];
    if (!accountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!auth) missing.push("TWILIO_API_KEY_SID+TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN)");
    if (!smsTo) missing.push("SILVEO_SMS_TO");
    sms.reason = `SMS not configured (missing ${missing.join(", ")})`;
  }

  // --- Email (Resend) ---
  const resendKey = clean(env.RESEND_API_KEY);
  const emailFrom = clean(env.EMAIL_FROM);
  const email =
    resendKey && emailFrom
      ? { configured: true, apiKey: resendKey, from: emailFrom, to: EMAIL_TO }
      : { configured: false, reason: "Email sender not configured yet" };

  return {
    problems,
    port: Number(clean(env.PORT) ?? 8080),
    webhookSecret,
    agentId,
    stateFile: clean(env.STATE_FILE) ?? "./data/state.json",
    sms,
    email,
  };
}
