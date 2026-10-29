import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Tiny JSON-file store keyed by conversation ID. Holds only send state
// (status, provider message ID, error code, timestamps) - no transcript, no
// names, no phone numbers.
//
// Channel status values:
//   sent      provider API accepted the message - never sent again
//   sending   a send was started but its result was never recorded (crash);
//             treated as "unknown" and NOT retried, to avoid duplicates
//   failed    provider rejected / network error - retried on the next delivery
//   pending   channel not configured - retried once it is configured

const KEEP_DAYS = 30;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { conversations: {} };
    try {
      this.data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  get(id) {
    return this.data.conversations[id];
  }

  setChannel(id, channel, state) {
    const entry = (this.data.conversations[id] ??= { firstSeen: new Date().toISOString() });
    entry[channel] = { ...state, at: new Date().toISOString() };
    this.flush();
  }

  flush() {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const [id, entry] of Object.entries(this.data.conversations)) {
      if (Date.parse(entry.firstSeen) < cutoff) delete this.data.conversations[id];
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}
