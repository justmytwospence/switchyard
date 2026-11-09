import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AdapterCatalog } from "../src/adapters.js";
import { AgentBroker } from "../src/agent-broker.js";
import { openHostDb } from "../src/db/index.js";
import type { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";
import { SessionSupervisor } from "../src/supervisor.js";
import { mockProfile } from "./helpers.js";

it("preserves the failed status and native handle when a protected resume file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-protected-resume-"));
  const db = openHostDb(join(dir, "host.db"));
  const link = {
    connected: true,
    negotiatedFeatures: new Set(["agentRequests.v1", "policies.v1"]),
    events: new EventEmitter(),
    emit: vi.fn(),
  } as unknown as CoordinatorLink;
  const broker = new AgentBroker({ link });
  const catalog = {
    forWorkspace: async () => ({ manifests: [], openSession: () => null, closeSession() {} }),
    manifests: () => [],
  } as unknown as AdapterCatalog;
  const supervisor = new SessionSupervisor({
    db,
    link,
    broker,
    hostId: "hst_1",
    catalog,
    log: silentLogger(),
    pi: () => ({ compatible: true, reason: null, version: "1.5.0" }),
  });
  const nativeHandle = { sessionId: "native", sessionFile: join(dir, "missing.jsonl") };
  const detail = `Native session file not found: ${nativeHandle.sessionFile}`;
  try {
    await expect(
      supervisor.start({
        sessionId: "ses_1",
        title: "Resume",
        workspacePath: dir,
        projectId: null,
        profile: mockProfile,
        nativeHandle,
        initialPrompt: null,
        dispatchKey: null,
        controlRevision: 1,
        controlMode: "automation",
        origin: "automation",
        policyRequired: true,
      }),
    ).rejects.toMatchObject({ code: "native_session_missing", message: detail });
    expect(supervisor.record("ses_1")).toMatchObject({
      runtime: "failed",
      runtimeDetail: detail,
      nativeHandle,
    });
    expect(db.getJson("SELECT json FROM sessions WHERE id = ?", ["ses_1"])).toMatchObject({
      runtime: "failed",
      runtimeDetail: detail,
      nativeHandle,
    });
    expect(supervisor.spawnedProcesses).toBe(0);
  } finally {
    broker.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
