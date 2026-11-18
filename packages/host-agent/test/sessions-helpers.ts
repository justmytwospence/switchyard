// Shared by the sessions*.test.ts files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEvent, Interaction, TranscriptItem } from "@switchyard/protocol";
import { type MockScript, when } from "@switchyard/test-fixtures";
import { type HostHarness, startCommand } from "./helpers.js";

export const ADAPTER_SERVER = `
export default {
  onToolStart(e, ctx) {
    if (e.name === "fixture_select") {
      ctx.queueAnswers({ method: "select", titleStartsWith: "Pick a fruit" }, [{ value: "Apple" }]);
    }
  },
  toolCard(tool) {
    if (tool.name !== "fixture_select") return undefined;
    return { t: "text", text: tool.result ? "fruit chosen" : "choosing fruit" };
  },
  onStatus(key) { return key === "fixture"; },
  onWidget(key) { return key === "fixture"; },
  onToolEnd(e, ctx) {
    if (e.name !== "fixture_select") return;
    ctx.state.set("lastFruit", e.details && e.details.value);
    ctx.setPanel("fruit", { t: "markdown", text: "Fruit: " + (e.details && e.details.value) }, { title: "Fruit" });
  },
};
`;

export function writeProjectAdapter(root: string): void {
  const dir = join(root, ".switchyard", "adapters", "fruit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "switchyard-adapter.json"),
    JSON.stringify({
      id: "fruit",
      version: "1.0.0",
      target: { extension: "fixture", versionRange: "*", testedVersions: [] },
      protocolVersion: 1,
      server: "server.mjs",
      webRenderer: null,
      capabilities: ["toolCards", "interactions", "panels", "state"],
    }),
  );
  writeFileSync(join(dir, "server.mjs"), ADAPTER_SERVER);
}

export const callTool = (name: string) => ({ toolCalls: [{ name, arguments: {} }] });

export const script: MockScript = [
  { when: when.userSays("pick"), reply: callTool("fixture_select") },
  { when: when.userSays("custom"), reply: callTool("fixture_custom") },
  { when: when.userSays("status"), reply: callTool("fixture_status") },
  { when: when.userSays("work slowly"), reply: callTool("fixture_slow") },
  { when: when.toolResult(), reply: (r) => ({ text: `tool said: ${r.lastText}` }) },
];

let n = 0;
export const sid = () => `ses_t${Date.now()}${++n}`;

export const isSettled = (sessionId: string) => (e: HostEvent) =>
  e.type === "session.updated" && e.sessionId === sessionId && (e.data as any).settled != null;

export async function startSession(h: HostHarness, sessionId: string, cwd: string, extra = {}) {
  return h.coord.ok(startCommand(sessionId, cwd, extra));
}

export function interactions(h: HostHarness, sessionId: string): Interaction[] {
  return h.coord.eventsOf("interaction.updated", sessionId).map((e) => e.data as Interaction);
}

export function items(h: HostHarness, sessionId: string): TranscriptItem[] {
  return h.coord.eventsOf("transcript.item", sessionId).map((e) => e.data as TranscriptItem);
}
