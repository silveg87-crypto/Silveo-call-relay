// Outbound sends. Each returns { ok: true, id } only when the provider's API
// accepted the message; anything else is { ok: false, error } with a short,
// non-personal error code that is safe to log.

export async function sendSms(sms, body, fetchImpl = fetch) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sms.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${sms.auth.user}:${sms.auth.pass}`).toString("base64");
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: sms.to, From: sms.from, Body: body }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && typeof json.sid === "string") {
      // "queued"/"accepted" means Twilio took it; carrier delivery is not yet known.
      return { ok: true, id: json.sid, providerStatus: json.status };
    }
    return { ok: false, error: `twilio_http_${res.status}${json.code ? `_code_${json.code}` : ""}` };
  } catch (err) {
    return { ok: false, error: `twilio_${err?.name === "TimeoutError" ? "timeout" : "network_error"}` };
  }
}

export async function sendEmail(email, { subject, text }, idempotencyKey, fetchImpl = fetch) {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${email.apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeated request with the same key for 24h.
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ from: email.from, to: [email.to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && typeof json.id === "string") return { ok: true, id: json.id };
    return { ok: false, error: `resend_http_${res.status}${json.name ? `_${json.name}` : ""}` };
  } catch (err) {
    return { ok: false, error: `resend_${err?.name === "TimeoutError" ? "timeout" : "network_error"}` };
  }
}
