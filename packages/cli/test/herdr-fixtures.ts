import type { Session } from "@switchyard/protocol";

export function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `Title ${id}`,
    subtitle: null,
    hostId: "hst_mac",
    workspaceId: "wsp_main",
    projectId: "prj_sy",
    cwd: "/repo",
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
    lastActivityAt: "2026-11-02T00:00:00Z",
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: `2026-11-02T00:00:0${id.slice(-1)}Z`,
    terminal: true,
    ...over,
  };
}
