import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { handleEvent, log } from "./relay.js";
import { verifySignature } from "./signature.js";
import { Store } from "./store.js";

export const WEBHOOK_PATH = "/webhooks/elevenlabs/post-call";
// Transcription payloads are small; audio webhooks are not wanted here.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createApp({ config, store, fetchImpl = fetch }) {
  return createServer(async (req, res) => {
    const path = new URL(req.url, "http://local").pathname;

    if (req.method === "GET" && path === "/healthz") {
      // The service itself is up (200) even while setup is incomplete, so the
      // host keeps it running; "ok" says whether webhooks are being accepted.
      return reply(res, 200, {
        ok: config.problems.length === 0,
        problems: config.problems,
        sms: config.sms.configured ? "configured" : "not configured",
        email: config.email.configured ? "configured" : "pending",
      });
    }
    if (path !== WEBHOOK_PATH) return reply(res, 404, { error: "not found" });
    if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
    if (config.problems.length) {
      log("rejected_not_configured");
      return reply(res, 503, { error: "relay not configured" });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      log("rejected_body", { reason: err.message });
      return reply(res, err.status ?? 400, { error: "bad body" });
    }

    const sig = verifySignature(raw, req.headers["elevenlabs-signature"], config.webhookSecret);
    if (!sig.ok) {
      log("rejected_signature", { reason: sig.reason });
      return reply(res, 401, { error: "invalid signature" });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      log("rejected_json");
      return reply(res, 400, { error: "invalid json" });
    }

    try {
      const { httpStatus, result } = await handleEvent(payload, { config, store, fetchImpl });
      return reply(res, httpStatus, { result });
    } catch (err) {
      log("error", { conversation_id: payload?.data?.conversation_id, error: err?.name ?? "Error" });
      return reply(res, 500, { error: "internal error" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = loadConfig();
  // Start anyway so the host gives the service a URL before the ElevenLabs
  // webhook (and its secret) exist; webhooks get 503 until this is fixed.
  for (const p of config.problems) console.error(`config error: ${p}`);
  const store = new Store(config.stateFile);
  createApp({ config, store }).listen(config.port, () => {
    log("listening", {
      port: config.port,
      accepting_webhooks: config.problems.length === 0,
      path: WEBHOOK_PATH,
      sms: config.sms.configured ? "configured" : config.sms.reason,
      email: config.email.configured ? "configured" : config.email.reason,
    });
  });
}
