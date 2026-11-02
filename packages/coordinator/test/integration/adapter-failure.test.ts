import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic, TranscriptItem } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, Integration, steps, uiResponses, waitFor } from "./harness.js";

const GATE_EXTENSION = fileURLToPath(new URL("./fixtures/gate-extension.js", import.meta.url));

const ADAPTER_SERVER = `
export default {
  claimInteraction(req) {
    if (req.method === "select" && req.title === "Allow this call?") {
      throw new Error("gatekeeper exploded while claiming");
    }
    return undefined;
  },
};
`;

/**
 * A project-tier adapter committed to the repo, so every task worktree carries it. It is the only
 * adapter on the host, so a failure leaves only the generic renderer.
 */
function addProjectAdapter(repo: string): void {
  const dir = join(repo, ".switchyard", "adapters", "gatekeeper");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "switchyard-adapter.json"),
    `${JSON.stringify(
      {
        id: "tool-gate",
        version: "1.0.0",
        target: { extension: "fixture-gate", versionRange: "*", testedVersions: [] },
        protocolVersion: 1,
        server: "server.js",
        webRenderer: null,
        capabilities: ["interactions"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "server.js"), ADAPTER_SERVER);
  git(repo, ["add", ".switchyard"]);
  git(repo, ["commit", "-q", "-m", "add gatekeeper adapter"]);
}

/** Spec §19: adapter failure without approval bypass. */
describe("project adapter failure", { timeout: 120_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create({
      extraExtensions: [GATE_EXTENSION],
      prepareRepo: addProjectAdapter,
    });
  });
  afterAll(async () => {
    await env?.dispose();
  });

  it("falls back to the generic form, emits a diagnostic, and waits for a human", async () => {
    const { desktop } = env.devices!;
    const web = await env.connect(desktop);
    const task = await env.createTask("admin", {
      title: "Gated call",
      objective: steps("gate", "done"),
      state: "ready",
    });
    const run = await env.waitRun(
      task.id,
      (r) => r.state === "running" || r.state === "waiting_input",
      "running",
    );
    const sid = run.sessionId!;
    const pid = await env.livePi(sid);
    const pending = await env.pendingInteraction(sid);

    // Generic fallback: no adapter owns the request; it is the plain select. The project adapter
    // is the only one on the host, so nothing else claims it.
    const host = await env.ok("GET", `/api/hosts/${env.hostId}`);
    expect(host.adapters).toEqual([
      expect.objectContaining({ id: "tool-gate", tier: "project", status: "active" }),
    ]);
    expect(pending.title).toBe("Allow this call?");
    expect(pending.adapterId).toBeNull();
    expect(pending.source).toMatchObject({ kind: "extension_ui", method: "select" });
    expect(JSON.stringify(pending.presentation)).toContain("Allow");
    expect(JSON.stringify(pending.presentation)).toContain("Block");

    // A diagnostic names the adapter and the failing hook.
    const diag = await web.waitEvent(
      (e) => e.type === "diagnostic" && (e.data as Diagnostic).adapterId === "tool-gate",
      "adapter diagnostic",
    );
    const d = diag.data as Diagnostic;
    expect(d.message).toContain("claimInteraction");
    expect(d.message).toContain("gatekeeper exploded");
    expect(d.sessionId).toBe(sid);

    // Still blocked: Pi has received no answer, the session waits, attention asks a human.
    await env.waitRun(task.id, (r) => r.state === "waiting_input", "waiting_input");
    expect(env.session(sid).runtime).toBe("waiting_input");
    expect(uiResponses.filter((r) => r.pid === pid)).toHaveLength(0);
    const snapshot = await env.ok("GET", `/api/sessions/${sid}/snapshot`);
    expect(snapshot.pendingInteractions.map((i: { id: string }) => i.id)).toEqual([pending.id]);
    const attention = await env.ok("GET", `/api/attention?sessionId=${sid}`);
    expect(attention.map((a: { reason: string }) => a.reason)).toContain("needs_input");
    expect(env.c.store.interactions.require(pending.id).state).toBe("pending");
    const tools = (env.c.store.listItems(sid, { limit: 1000 }).items as TranscriptItem[]).filter(
      (i) => i.kind === "tool" && (i.data as { name: string }).name === "fixture_gate",
    );
    expect(tools.at(-1)!.data).toMatchObject({ status: "running" });

    // A human answers Block: exactly one response reaches Pi and the call is blocked.
    const r = await env.api("POST", `/api/interactions/${pending.id}/answer`, {
      as: desktop,
      body: { revision: pending.revision, response: { kind: "form", values: { value: "Block" } } },
    });
    expect(r.status).toBe(200);
    expect(r.body.interaction.resolution.by).toBe(desktop.id);
    await waitFor(() => uiResponses.some((x) => x.pid === pid), "response written");
    expect(uiResponses.filter((x) => x.pid === pid)).toEqual([
      { pid, id: expect.any(String), body: { value: "Block" } },
    ]);
    await env.waitTaskState(task.id, "review");
    const items = env.c.store.listItems(sid, { limit: 1000 }).items as TranscriptItem[];
    const gate = items.filter(
      (i) => i.kind === "tool" && (i.data as { name: string }).name === "fixture_gate",
    );
    expect(JSON.stringify(gate.at(-1)!.data)).toContain("call blocked (Block)");
  });
});
