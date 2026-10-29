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
      return reply(res, 200, {
        ok: true,
        sms: config.sms.configured ? "configured" : "not configured",
        email: config.email.configured ? "configured" : "pending",
      });
    }
    if (path !== WEBHOOK_PATH) return reply(res, 404, { error: "not found" });
    if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });

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
  if (config.problems.length) {
    for (const p of config.problems) console.error(`config error: ${p}`);
    process.exit(1);
  }
  const store = new Store(config.stateFile);
  createApp({ config, store }).listen(config.port, () => {
    log("listening", {
      port: config.port,
      path: WEBHOOK_PATH,
      sms: config.sms.configured ? "configured" : config.sms.reason,
      email: config.email.configured ? "configured" : config.email.reason,
    });
  });
}
