import type {
  EventEnvelope,
  Host,
  Interaction,
  Project,
  Run,
  Session,
  SyncState,
  TranscriptItem,
  UINode,
} from "@switchyard/protocol";

const T = "2026-11-02T10:00:00.000Z";

export function host(over: Partial<Host> = {}): Host {
  return {
    id: "hst_1",
    name: "mac",
    platform: "darwin",
    agentVersion: "0.1.0",
    piVersion: "1.4.0",
    piCompatible: true,
    capabilities: {
      prompt: true,
      steer: true,
      followUp: true,
      abort: true,
      resume: true,
      rename: true,
      importInactive: true,
      extensionDialogs: true,
      customUi: false,
      widgetsText: true,
      widgetsComponent: false,
      tokenAccounting: true,
      costAccounting: true,
      unsupported: [],
    },
    connectivity: "connected",
    lastSeenAt: T,
    revokedAt: null,
    createdAt: T,
    ...over,
  };
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    name: "alpha",
    repoIdentity: "https://github.com/x/alpha",
    defaultProfileId: null,
    defaultHostId: null,
    maxConcurrentRuns: 1,
    automationEnabled: true,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function session(over: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    title: "Fix login",
    subtitle: null,
    hostId: "hst_1",
    workspaceId: null,
    projectId: "prj_1",
    cwd: "/repo",
    nativeHandle: null,
    profileSnapshot: {
      id: "prf_1",
      name: "default",
      provider: null,
      model: null,
      thinking: null,
      projectTrust: "ask",
      extraArgs: [],
    },
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: T,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: T,
    ...over,
  };
}

export function run(over: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    taskId: "tsk_1",
    sessionId: "ses_1",
    hostId: "hst_1",
    dispatchKey: "run_1",
    attempt: 1,
    state: "running",
    controlMode: "automation",
    controlRevision: 1,
    continuationsUsed: 0,
    infraRetries: 0,
    nextAttemptAt: null,
    startedAt: T,
    endedAt: null,
    outcome: null,
    limits: { enabled: false },
    usage: { tokens: null, costUsd: null, accounting: "unavailable", note: null },
    checks: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function interaction(presentation: UINode, over: Partial<Interaction> = {}): Interaction {
  return {
    id: "int_1",
    sessionId: "ses_1",
    revision: 1,
    source: { kind: "extension_ui", method: "select", piRequestIds: ["r1"] },
    adapterId: null,
    title: "Pick one",
    presentation,
    state: "pending",
    resolution: null,
    createdAt: T,
    ...over,
  };
}

export function item(over: Partial<TranscriptItem> & Pick<TranscriptItem, "kind" | "data">) {
  return {
    id: "itm_1",
    sessionId: "ses_1",
    order: 1,
    at: T,
    ...over,
  } as TranscriptItem;
}

export function syncState(over: Partial<SyncState> = {}): SyncState {
  return {
    hosts: [host()],
    projects: [project()],
    checkouts: [],
    workspaces: [],
    profiles: [],
    sessions: [session()],
    tasks: [],
    runs: [],
    automations: [],
    attention: [],
    interactions: [],
    panels: [],
    devices: [],
    adapters: {},
    dispatchPaused: false,
    ...over,
  };
}

export function event(seq: number, type: EventEnvelope["type"], data: unknown): EventEnvelope {
  return { seq, id: `evt_${seq}`, type, at: T, data };
}
