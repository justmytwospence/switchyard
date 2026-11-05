#!/usr/bin/env node
// A fake `pi --mode rpc` for transport tests: answers get_state, rejects get_available_models,
// never answers get_commands or `/slow` prompts. FAKE_PI_HANG=1 never answers anything.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const at = args.indexOf("--session-id");
const sessionId = at >= 0 ? args[at + 1] : "fake-session";
const hang = process.env.FAKE_PI_HANG === "1";

const reply = (id, command, success, data, error) => {
  const rec = { type: "response", id, command, success };
  if (data !== undefined) rec.data = data;
  if (error !== undefined) rec.error = error;
  process.stdout.write(`${JSON.stringify(rec)}\n`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (hang) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  const { id, type } = cmd;
  switch (type) {
    case "get_state":
      reply(id, type, true, {
        sessionId,
        sessionFile: "/tmp/fake.jsonl",
        isStreaming: false,
        model: null,
        thinkingLevel: null,
      });
      return;
    case "get_available_models":
      reply(id, type, false, undefined, "no models");
      return;
    case "get_commands":
      return;
    case "prompt":
      if (typeof cmd.message === "string" && cmd.message.startsWith("/slow")) return;
      reply(id, type, true, { disposition: "started" });
      return;
    default:
      reply(id, type, true, {});
  }
});
