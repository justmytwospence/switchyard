import { basename, join } from "node:path";
import type { Host, Project, Session } from "@switchyard/protocol";

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  cwd?: string | null;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label?: string | null;
}

export interface PlanInput {
  sessions: Session[];
  hosts: Host[];
  projects: Project[];
  panes: HerdrPane[];
  workspaces: HerdrWorkspace[];
  /** Realpath of `<state>/sessions`: each session's pane runs in `<sessionsDir>/<sessionId>`. */
  sessionsDir: string;
  /** Sessions whose pane was parked (`q` in the pane). */
  parked: Set<string>;
  /** Consecutive ticks each mapped session was not live (mutated). */
  goneTicks: Map<string, number>;
}

export type AgentState = "idle" | "working" | "blocked";

export interface Plan {
  create: { sessionId: string; label: string }[];
  rename: { workspaceId: string; label: string }[];
  close: string[];
  report: { paneId: string; state: AgentState; message: string; customStatus: string }[];
  /** Panes of live, unparked sessions; re-run the pane command in those sitting at their shell. */
  restartCandidates: { paneId: string; sessionId: string }[];
}

/** Ticks a session must be gone before its space closes. */
export const CLOSE_AFTER_TICKS = 2;
const LABEL_MAX = 40;

export function isLiveTerminal(s: Session): boolean {
  return s.terminal === true && s.archivedAt === null;
}

export function agentState(runtime: Session["runtime"]): AgentState {
  if (runtime === "running" || runtime === "starting") return "working";
  if (runtime === "waiting_input") return "blocked";
  return "idle";
}

/** `<project or cwd basename> · <title>`, cut to 40 characters. */
export function sessionLabel(s: Session, projects: Project[]): string {
  const project = projects.find((p) => p.id === s.projectId)?.name ?? (basename(s.cwd) || "pi");
  const label = `${project} · ${s.title}`;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** The session a pane belongs to, from its cwd. */
export function sessionOfPane(pane: HerdrPane, sessionsDir: string): string | null {
  const cwd = pane.cwd ?? "";
  const prefix = `${sessionsDir}/`;
  if (!cwd.startsWith(prefix)) return null;
  const rest = cwd.slice(prefix.length);
  return rest && !rest.includes("/") ? rest : null;
}

export function sessionDir(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId);
}

/** Compare Switchyard's terminal sessions with herdr's spaces and say what to change. */
export function planHerdr(input: PlanInput): Plan {
  const plan: Plan = { create: [], rename: [], close: [], report: [], restartCandidates: [] };
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const live = new Map(input.sessions.filter(isLiveTerminal).map((s) => [s.id, s]));
  const panesBySession = new Map<string, HerdrPane[]>();
  const workspacePanes = new Map<string, HerdrPane[]>();
  for (const p of input.panes) {
    workspacePanes.set(p.workspace_id, [...(workspacePanes.get(p.workspace_id) ?? []), p]);
    const id = sessionOfPane(p, input.sessionsDir);
    if (id) panesBySession.set(id, [...(panesBySession.get(id) ?? []), p]);
  }
  const labels = new Map(input.workspaces.map((w) => [w.workspace_id, w.label ?? null]));
  const hostName = (s: Session) => input.hosts.find((h) => h.id === s.hostId)?.name ?? s.hostId;

  for (const s of live.values()) {
    input.goneTicks.delete(s.id);
    const panes = panesBySession.get(s.id) ?? [];
    if (panes.length === 0) {
      if (!input.parked.has(s.id)) {
        plan.create.push({ sessionId: s.id, label: sessionLabel(s, input.projects) });
      }
      continue;
    }
    const label = sessionLabel(s, input.projects);
    for (const ws of new Set(panes.map((p) => p.workspace_id))) {
      if (labels.has(ws) && labels.get(ws) !== label) plan.rename.push({ workspaceId: ws, label });
    }
    for (const p of panes) {
      plan.report.push({
        paneId: p.pane_id,
        state: agentState(s.runtime),
        message: `${s.title} · ${s.runtime}`,
        customStatus: hostName(s),
      });
      if (!input.parked.has(s.id))
        plan.restartCandidates.push({ paneId: p.pane_id, sessionId: s.id });
    }
  }

  // Spaces of sessions that are no longer live close after a grace period.
  const gone = new Set<string>();
  for (const id of panesBySession.keys()) {
    if (live.has(id)) continue;
    const ticks = (input.goneTicks.get(id) ?? 0) + 1;
    input.goneTicks.set(id, ticks);
    if (ticks >= CLOSE_AFTER_TICKS) gone.add(id);
    const s = byId.get(id);
    if (s && ticks < CLOSE_AFTER_TICKS) {
      for (const p of panesBySession.get(id) ?? []) {
        plan.report.push({
          paneId: p.pane_id,
          state: "idle",
          message: `${s.title} · ${s.runtime}`,
          customStatus: hostName(s),
        });
      }
    }
  }
  for (const [ws, panes] of workspacePanes) {
    const owners = panes.map((p) => sessionOfPane(p, input.sessionsDir));
    if (owners.length > 0 && owners.every((o) => o !== null && gone.has(o))) plan.close.push(ws);
  }
  for (const id of gone) input.goneTicks.delete(id);
  return plan;
}
