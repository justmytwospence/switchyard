import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHostAgent, silentLogger } from "@switchyard/host-agent";
import type { Session } from "@switchyard/protocol";
import { fixtureExtensionPath, piBin } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Integration, sessionFiles, steps, tempDir, waitFor } from "./harness.js";

const gate = fileURLToPath(new URL("./fixtures/gate-extension.js", import.meta.url));
const archivedBridge = fileURLToPath(
  new URL("./fixtures/legacy-terminal-v0.11.0.js.txt", import.meta.url),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Only the Pi extension is old. The actual coordinator, host, holder and Pi are real.
 * The holder is unchanged since v0.11.0; no installed/source production file is patched.
 * A temporary launcher substitutes the archived bridge ONLY for the first host's new Pi.
 * Restarting with the ordinary Pi binary must reattach, not run this launcher or a new bridge.
 */
function legacyLauncher(dir: string): { bin: string; launches: string } {
  const bridge = join(dir, "legacy-terminal.mjs");
  copyFileSync(archivedBridge, bridge);
  const realPi = execFileSync("/usr/bin/which", [piBin()], { encoding: "utf8" }).trim();
  const launches = join(dir, "launches.txt");
  const bin = join(dir, "pi-legacy");
  writeFileSync(
    bin,
    `#!/bin/bash
args=()
legacy=0
for arg in "$@"; do
  case "$arg" in
    */bridge/switchyard-terminal.js)
      args+=(${quote(bridge)})
      legacy=1
      ;;
    *) args+=("$arg") ;;
  esac
done
if [[ "$legacy" == 1 ]]; then printf '%s\\n' "$$" >> ${quote(launches)}; fi
exec ${quote(realPi)} "\${args[@]}"
`,
    { mode: 0o700 },
  );
  return { bin, launches };
}

function parentPid(pid: number): number {
  return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }));
}

// This is a distinct release gate, NOT the committed-receipt replay or fake-old-host test.
// Deliberately no skipRealPi/terminalSupport skip: a missing real dependency must fail.
describe("a real surviving legacy terminal holder", { timeout: 180_000 }, () => {
  let env: Integration;
  let dir: string;
  let holder: { pid: number; piPid: number } | undefined;
  const viewers: WebSocket[] = [];

  afterEach(async () => {
    for (const viewer of viewers.splice(0)) viewer.terminate();
    // Integration normally runs RPC. Explicitly stop this test's surviving terminal before
    // disposing the host (a graceful host stop intentionally leaves its holders alive).
    if (env?.agent) await env.agent.supervisor.stopAll({ terminals: "stop" });
    // Also cover a failure BETWEEN detaching the old host and attaching the new one.
    // At that point neither supervisor owns this test's still-running holder.
    if (holder) {
      for (const pid of [holder.pid, holder.piPid]) {
        try {
          globalThis.process.kill(pid, "SIGTERM");
        } catch {
          // Already exited during normal supervisor shutdown.
        }
      }
      holder = undefined;
    }
    await env?.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function startTerminalAgent(bin: string) {
    const agent = await runHostAgent({
      configPath: env.configPath,
      stateDir: env.stateDir,
      piBin: bin,
      env: env.pi!.env,
      extraExtensions: [fixtureExtensionPath(), gate],
      ownerAdapterDir: env.ownerAdapterDir,
      terminalSessions: true,
      handleSignals: false,
      backoffMs: [50, 100, 200],
      logger: silentLogger(),
      testHooks: { onCommand: (command) => env.hostCommands.push(command) },
    });
    env.agent = agent;
    env.agents.push(agent);
    await env.waitHostConnected();
    expect(agent.terminalSessions, "real node-pty/holder support is required").toBe(true);
    return agent;
  }

  it("reattaches without restarting Pi, stays browsable/unprotected, and refuses protected reuse and continuation", async () => {
    env = await Integration.create({ extraExtensions: [gate] });
    await env.agent!.stop();
    dir = tempDir("sy-legacy-holder-");
    const launcher = legacyLauncher(dir);
    const oldAgent = await startTerminalAgent(launcher.bin);
    const destructive = (await env.ok("GET", "/api/policies")).find(
      (rule: { id: string }) => rule.id === "destructive-shell",
    );
    await env.ok("PATCH", `/api/policies/${destructive.id}`, {
      body: { expectedRevision: destructive.revision, enabled: false },
    });
    // No token/USD caps: the untouched seeded budget rules alone don't require protection.
    // Hold an ACTUAL turn open across the upgrade; it must be allowed to finish afterwards.
    const task = await env.createTask("admin", {
      title: "Legacy live turn",
      objective: steps("gate", "talk"),
      state: "ready",
      policy: {
        workspace: { mode: "existing", workspaceId: env.mainWorkspaceId },
        continuation: {
          enabled: true,
          objective: "Continue only when protected",
          maxContinuations: 2,
          maxElapsedMinutes: 10,
          maxTokens: null,
          maxCostUsd: null,
        },
      },
    });
    const run = await env.waitRun(task.id, (r) => r.sessionId !== null, "legacy run allocated");
    const sid = run.sessionId!;
    const question = await env.pendingInteraction(sid);
    expect(question.permission).toBeUndefined();
    expect(question.title).toBe("Allow this call?");
    const original = await env.waitSession(
      sid,
      (s) => s.runtime === "waiting_input" && s.nativeHandle !== null && s.terminal === true,
      "legacy Pi awaiting its real terminal dialog",
    );
    const process = oldAgent.supervisor.managedSession(sid)!.process!;
    const pid = process.pid!;
    const holderPid = parentPid(pid);
    holder = { pid: holderPid, piPid: pid };
    const socket = oldAgent.supervisor.record(sid)!.terminal!.socketPath;
    const files = sessionFiles(env.pi!.sessionsDir);
    expect(files).toContain(original.nativeHandle!.sessionFile);
    expect(oldAgent.supervisor.managedSession(sid)!.remoteDialogs).toBe(true);
    expect(oldAgent.supervisor.managedSession(sid)!.bridgeFeatures).toBeNull();
    expect(original.bridge).toBeUndefined();
    expect(readFileSync(launcher.launches, "utf8").trim()).toBe(String(pid));
    expect(oldAgent.spawnedPiProcesses).toBe(1);

    await oldAgent.stop();
    expect(() => globalThis.process.kill(pid, 0)).not.toThrow();
    expect(() => globalThis.process.kill(holderPid, 0)).not.toThrow();
    expect(existsSync(socket)).toBe(true);
    await env.restartCoordinator();
    const disabled = (await env.ok("GET", "/api/policies")).find(
      (rule: { id: string }) => rule.id === "destructive-shell",
    );
    await env.ok("PATCH", `/api/policies/${disabled.id}`, {
      body: { expectedRevision: disabled.revision, enabled: true },
    });
    // Listen BEFORE host reattachment: even transient host-capability-derived "active"
    // updates would be a false protection badge on clients.
    const client = await env.connect(env.devices!.desktop);
    // The upgraded host has potential policy support, but this old live bridge has NONE.
    const upgraded = await startTerminalAgent(piBin());
    expect(upgraded.interruptedOnStart).toEqual([]);
    await env.waitSession(sid, (s) => s.connectivity === "connected", "legacy reattached");
    const host = await env.ok("GET", `/api/hosts/${env.hostId}`);
    expect(host.capabilities).toMatchObject({
      agentRequests: true,
      policies: true,
      terminal: true,
    });
    expect(env.c.hostHub.negotiatedFeatures(env.hostId)).toEqual(
      new Set(["agentRequests.v1", "policies.v1"]),
    );
    expect(upgraded.spawnedPiProcesses).toBe(0);
    expect(upgraded.supervisor.isLive(sid)).toBe(true);
    expect(upgraded.supervisor.managedSession(sid)!.process!.pid).toBe(pid);
    expect(parentPid(pid)).toBe(holderPid);
    expect(upgraded.supervisor.record(sid)!.terminal!.socketPath).toBe(socket);
    expect(upgraded.supervisor.managedSession(sid)!.remoteDialogs).toBe(true);
    expect(upgraded.supervisor.managedSession(sid)!.bridgeFeatures).toBeNull();
    expect(upgraded.supervisor.managedSession(sid)!.snapshot().bridge).toBeNull();
    expect(env.session(sid).nativeHandle).toEqual(original.nativeHandle);
    expect(env.session(sid).bridge).toBeUndefined();
    expect(
      env.c.store.db
        .prepare("SELECT * FROM policy_runtime_boundaries WHERE session_id = ?")
        .all(sid),
    ).toHaveLength(0);

    // Device API + snapshot/event stream are the badge's source of truth, not host capability.
    const browsed = (await env.ok("GET", `/api/sessions/${sid}`, {
      as: env.devices!.desktop,
    })) as Session;
    expect(browsed).toMatchObject({ terminal: true, connectivity: "connected" });
    expect(browsed.bridge).toBeUndefined();
    const transcript = await env.ok("GET", `/api/sessions/${sid}/transcript`, {
      as: env.devices!.desktop,
    });
    expect(transcript.items.some((item: any) => item.kind === "user")).toBe(true);
    const viewer = new WebSocket(
      `${env.url.replace(/^http/, "ws")}/ws/terminal/${sid}?cols=100&rows=30`,
      { headers: env.headersFor(env.devices!.terminal) },
    );
    viewers.push(viewer);
    viewer.on("error", () => {}); // Open/relay failures surface through the bounded output wait.
    const output: string[] = [];
    viewer.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.t === "out") output.push(Buffer.from(frame.d, "base64").toString());
    });
    await waitFor(() => output.join("").length > 0, "real legacy terminal paints via coordinator");

    const commandsBeforeFinish = env.hostCommands.length;
    const requestsBeforeFinish = env.mock!.requests.length;
    const pending = await env.pendingInteraction(sid);
    // Reattachment can re-project the pending dialog under a new coordinator id.
    expect(pending.title).toBe(question.title);
    expect(pending.source).toEqual(question.source);
    expect(pending.permission).toBeUndefined();
    await env.ok("POST", `/api/interactions/${pending.id}/answer`, {
      as: env.devices!.desktop,
      body: { revision: pending.revision, response: { kind: "form", values: { value: "Allow" } } },
    });
    // The old process can finish its in-flight turn; no protected automated next turn is sent.
    await env.waitSession(sid, (s) => s.runtime === "idle", "old live turn finishes after upgrade");
    await waitFor(() => env.task(task.id).blocked !== null, "protected continuation rejected");
    expect(env.mock!.requests).toHaveLength(requestsBeforeFinish + 1);
    expect(env.session(sid).lastAssistantText).toBe("Still working on it.");
    expect(env.task(task.id).blocked!.reason).toContain("Existing sessions are not protected");
    expect(env.run(task.id)).toMatchObject({ id: run.id, continuationsUsed: 0 });

    const requestsBeforeRetry = env.mock!.requests.length;
    const runsBeforeRetry = await env.ok("GET", `/api/tasks/${task.id}/runs`);
    const retry = await env.api("POST", `/api/tasks/${task.id}/new-attempt`, {
      as: env.devices!.terminal,
    });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Existing sessions are not protected"),
      details: { wait: "invalid_configuration" },
    });
    expect(await env.ok("GET", `/api/tasks/${task.id}/runs`)).toEqual(runsBeforeRetry);
    expect(env.mock!.requests).toHaveLength(requestsBeforeRetry);
    expect(
      env.hostCommands
        .slice(commandsBeforeFinish)
        .filter((command) =>
          ["session.start", "dispatch.start", "session.prompt", "session.reload"].includes(
            command.type,
          ),
        ),
    ).toEqual([]);
    expect(upgraded.spawnedPiProcesses).toBe(0);
    expect(upgraded.supervisor.managedSession(sid)!.process!.pid).toBe(pid);
    expect(parentPid(pid)).toBe(holderPid);
    expect(sessionFiles(env.pi!.sessionsDir)).toEqual(files);
    expect(readFileSync(launcher.launches, "utf8").trim()).toBe(String(pid));
    expect((await env.ok("GET", `/api/sessions/${sid}`)).bridge).toBeUndefined();
    await waitFor(() => client.lastSeq >= env.c.store.currentSeq(), "client caught up");
    const snapshot = client.messages.find((message) => message.type === "snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot!.state.sessions.find((session) => session.id === sid)?.bridge).toBeUndefined();
    expect(snapshot!.state.sessions.some((session) => session.id === sid)).toBe(true);
    expect(
      client.events
        .filter((event) => event.type === "session.updated" && event.sessionId === sid)
        .some((event) => (event.data as Session).bridge?.policyState === "active"),
    ).toBe(false);
  });
});
