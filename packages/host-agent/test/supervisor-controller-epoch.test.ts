// biome-ignore-all lint/complexity/useLiteralKeys: Exercise private supervisor wiring without starting Pi.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ManagedSession } from "@switchyard/pi-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterCatalog } from "../src/adapters.js";
import type { AgentBroker, AgentBrokerSession, AgentBrokerState } from "../src/agent-broker.js";
import { HostDb } from "../src/db/index.js";
import type { CoordinatorLink } from "../src/link.js";
import { silentLogger } from "../src/logger.js";
import { type HostSessionRecord, SessionSupervisor } from "../src/supervisor.js";
import { mockProfile } from "./helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

it("persists broker controller proof before active and preserves it in lost host projections", () => {
  const db = new HostDb(":memory:");
  db.migrate();
  cleanup.push(() => db.close());
  const originalEpoch = randomUUID();
  const original: AgentBrokerState = {
    version: 1,
    runtimeId: "runtime",
    nativeSessionId: "native",
    controllerEpoch: originalEpoch,
    policyState: "active",
    policyPhases: ["tool_call", "request"],
    agentTools: true,
    messageDelivery: true,
  };
  const now = new Date().toISOString();
  const rec: HostSessionRecord = {
    id: "session",
    title: "Session",
    subtitle: null,
    cwd: "/repo",
    workspaceRoot: "/repo",
    projectId: null,
    workspaceId: null,
    runId: null,
    taskId: null,
    dispatchKey: null,
    profile: mockProfile,
    nativeHandle: null,
    runtime: "idle",
    runtimeDetail: null,
    controlRevision: 1,
    controlMode: "human",
    origin: "human",
    readOnly: false,
    provenance: "created",
    nextOrder: 0,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    lastActivityAt: now,
    createdAt: now,
    bridge: original,
  };
  let adapter!: AgentBrokerSession;
  const supervisor = new SessionSupervisor({
    db,
    link: { emit: vi.fn() } as unknown as CoordinatorLink,
    hostId: "host",
    catalog: {} as AdapterCatalog,
    log: silentLogger(),
    broker: {
      attach: (session: AgentBrokerSession) => {
        adapter = session;
        return {};
      },
    } as unknown as AgentBroker,
    pi: () => ({ compatible: true, reason: null }),
  });
  const ms = Object.assign(new EventEmitter(), {
    isAlive: true,
    transport: "rpc",
  }) as unknown as ManagedSession;
  const live = supervisor["newLive"](rec);
  live.ms = ms;
  supervisor["live"].set(rec.id, live);
  supervisor["wire"](live, ms);
  expect(supervisor.toSession(rec).bridge).toMatchObject({
    controllerEpoch: originalEpoch,
    policyState: "lost",
  });
  const next: AgentBrokerState = {
    ...original,
    controllerEpoch: randomUUID(),
    policyState: "initializing",
    policyPhases: [],
  };
  adapter.onState!(next);
  const persisted = () =>
    JSON.parse(
      (db.get("SELECT json FROM sessions WHERE id = ?", [rec.id]) as { json: string }).json,
    ) as HostSessionRecord;
  expect(persisted().bridge).toEqual(next);
  expect(supervisor.toSession(rec).bridge).toEqual(next);
  adapter.onState!({ ...next, policyState: "active", policyPhases: ["tool_call", "request"] });
  expect(persisted().bridge).toMatchObject({
    controllerEpoch: next.controllerEpoch,
    policyState: "active",
  });
  adapter.onState!({ ...next, policyState: "lost" });
  expect(persisted().bridge).toMatchObject({
    controllerEpoch: next.controllerEpoch,
    policyState: "lost",
  });
});
