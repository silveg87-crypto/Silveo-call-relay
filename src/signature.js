import { createHmac, timingSafeEqual } from "node:crypto";

// Mirrors ElevenLabs' official SDK (webhooks.constructEvent):
//   header  ElevenLabs-Signature: t=<unix seconds>,v0=<hex HMAC-SHA256>
//   signed  `${t}.${rawBody}` with the webhook's shared secret
//   reject  timestamps older than 30 minutes
const TOLERANCE_SECS = 30 * 60;
// Not in the SDK; guards against a forged far-future timestamp.
const MAX_FUTURE_SKEW_SECS = 5 * 60;

export function verifySignature(rawBody, header, secret, nowMs = Date.now()) {
  if (!secret) return { ok: false, reason: "secret not configured" };
  if (!header) return { ok: false, reason: "missing signature header" };

  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v0 = parts.find((p) => p.startsWith("v0="))?.slice(3);
  if (!t || !v0 || !/^\d+$/.test(t)) return { ok: false, reason: "malformed signature header" };

  const ageSecs = nowMs / 1000 - Number(t);
  if (ageSecs > TOLERANCE_SECS) return { ok: false, reason: "timestamp too old" };
  if (ageSecs < -MAX_FUTURE_SKEW_SECS) return { ok: false, reason: "timestamp in the future" };

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  let given;
  try {
    given = Buffer.from(v0, "hex");
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

// Used by tests and the local test script to build a valid header.
export function signPayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const hex = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v0=${hex}`;
}
