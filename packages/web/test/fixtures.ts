import type {
  AttentionItem,
  EventEnvelope,
  EventType,
  Interaction,
  Session,
  SyncState,
  Task,
  TranscriptItem,
} from "@switchyard/protocol";
import { DEFAULT_TASK_POLICY } from "@switchyard/protocol";

const T0 = "2026-11-01T10:00:00.000Z";

export function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    projectId: "prj_1",
    title: `Task ${id}`,
    objective: "",
    acceptanceCriteria: [],
    dependencies: [],
    priority: 2,
    position: 0,
    state: "backlog",
    blocked: null,
    notBefore: null,
    policy: DEFAULT_TASK_POLICY,
    origin: { kind: "manual" },
    groupingKey: null,
    currentRunId: null,
    sessionId: null,
    review: { feedback: [], changesRequested: false },
    hiddenFromBoard: false,
    lastActivityAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

export function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    subtitle: null,
    hostId: "hst_1",
    workspaceId: null,
    projectId: "prj_1",
    cwd: "/tmp",
    nativeHandle: null,
    profileSnapshot: {
      id: "prf_1",
      name: "Default",
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
    lastActivityAt: T0,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: T0,
    ...patch,
  };
}

export function attention(id: string, patch: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    sessionId: "ses_1",
    taskId: null,
    projectId: "prj_1",
    reason: "needs_input",
    severity: "warning",
    summary: "Question",
    interactionId: null,
    deepLink: "/code/ses_1",
    acknowledgedAt: null,
    resolvedAt: null,
    createdAt: T0,
    ...patch,
  };
}

export function interaction(id: string, patch: Partial<Interaction> = {}): Interaction {
  return {
    id,
    sessionId: "ses_1",
    revision: 1,
    source: { kind: "extension_ui", method: "select", piRequestIds: ["r1"] },
    adapterId: null,
    title: "Pick one",
    presentation: { t: "text", text: "hi" },
    state: "pending",
    resolution: null,
    createdAt: T0,
    ...patch,
  };
}

export function assistant(
  id: string,
  order: number,
  text: string,
  sessionId = "ses_1",
): TranscriptItem {
  return { id, sessionId, order, at: T0, kind: "assistant", data: { text } };
}

export function snapshot(patch: Partial<SyncState> = {}): SyncState {
  return {
    hosts: [],
    projects: [],
    checkouts: [],
    workspaces: [],
    profiles: [],
    views: [],
    sessions: [],
    tasks: [],
    runs: [],
    automations: [],
    attention: [],
    interactions: [],
    panels: [],
    devices: [],
    adapters: {},
    dispatchPaused: false,
    ...patch,
  };
}

let nextSeq = 1;
export function ev<T extends EventType>(type: T, data: unknown, seq = nextSeq++): EventEnvelope {
  return { seq, id: `evt_${seq}`, type, at: T0, data };
}
