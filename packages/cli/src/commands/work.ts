import type {
  Automation,
  Host,
  Occurrence,
  Project,
  Session,
  Task,
  TaskState,
} from "@switchyard/protocol";
import { PRIORITY_LABELS, TaskState as TaskStateSchema } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { ago, type Ctx, connect, printList } from "../context.js";

export interface ListFlags extends ConnectionFlags {
  json?: boolean;
}

function byId<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

/** Accept a project id or a (case-insensitive) unique project name. */
export async function resolveProject(api: ApiClient, ref: string): Promise<Project> {
  const projects = await api.get<Project[]>("/api/projects");
  const exact = projects.find((p) => p.id === ref);
  if (exact) return exact;
  const named = projects.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new CliError(`Several projects are named "${ref}"; use the id`);
  const known = projects.map((p) => `${p.name} (${p.id})`).join(", ") || "none";
  throw new CliError(`Unknown project "${ref}". Projects: ${known}`);
}

// sessions

export async function sessionsList(
  ctx: Ctx,
  flags: ListFlags & { project?: string },
): Promise<void> {
  const { api } = connect(ctx, flags);
  const projectId = flags.project ? (await resolveProject(api, flags.project)).id : undefined;
  const [sessions, projects, hosts] = await Promise.all([
    api.get<Session[]>(
      `/api/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
    api.get<Project[]>("/api/projects"),
    api.get<Host[]>("/api/hosts"),
  ]);
  const p = byId(projects);
  const h = byId(hosts);
  printList(
    ctx,
    flags.json,
    sessions,
    ["ID", "RUNTIME", "PROJECT", "HOST", "ACTIVE", "TITLE"],
    sessions.map((s) => [
      s.id,
      s.runtime,
      (s.projectId && p.get(s.projectId)?.name) || "-",
      h.get(s.hostId)?.name ?? s.hostId,
      ago(s.lastActivityAt),
      s.title,
    ]),
    "No sessions.",
  );
}

export async function sessionsImport(
  ctx: Ctx,
  sessionFile: string,
  flags: ConnectionFlags & { host?: string; project?: string; json?: boolean },
): Promise<Session> {
  const { api } = connect(ctx, flags);
  let hostId = flags.host;
  if (!hostId) {
    const hosts = (await api.get<Host[]>("/api/hosts")).filter((x) => !x.revokedAt);
    if (hosts.length !== 1) {
      throw new CliError(
        `Choose a host with --host (${hosts.map((x) => `${x.name}: ${x.id}`).join(", ") || "none enrolled"})`,
      );
    }
    hostId = hosts[0]!.id;
  }
  const projectId = flags.project ? (await resolveProject(api, flags.project)).id : null;
  const session = await api.post<Session>("/api/sessions/import", {
    hostId,
    sessionFile,
    projectId,
  });
  if (flags.json) ctx.out(JSON.stringify(session, null, 2));
  else ctx.out(`Imported ${session.title} as ${session.id} (stopped; resume it to continue)`);
  return session;
}

// tasks

export interface TaskCreateFlags extends ConnectionFlags {
  project: string;
  title: string;
  objective?: string;
  criteria?: string[];
  priority?: string;
  ready?: boolean;
  json?: boolean;
}

/** The `POST /api/tasks` body for `tasks create`. */
export function taskCreateBody(projectId: string, flags: TaskCreateFlags) {
  const body: {
    projectId: string;
    title: string;
    objective: string;
    acceptanceCriteria: string[];
    state: "backlog" | "ready";
    priority?: 0 | 1 | 2 | 3;
  } = {
    projectId,
    title: flags.title,
    objective: flags.objective ?? "",
    acceptanceCriteria: (flags.criteria ?? []).map((c) => c.trim()).filter(Boolean),
    state: flags.ready ? "ready" : "backlog",
  };
  if (flags.priority !== undefined) body.priority = parsePriority(flags.priority);
  return body;
}

export function parsePriority(v: string): 0 | 1 | 2 | 3 {
  const byName = PRIORITY_LABELS.findIndex((l) => l.toLowerCase() === v.toLowerCase());
  const n = byName >= 0 ? byName : Number(v);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new CliError(`Priority must be 0-3 or one of ${PRIORITY_LABELS.join(", ")}`);
}

export async function tasksCreate(ctx: Ctx, flags: TaskCreateFlags): Promise<Task> {
  const { api } = connect(ctx, flags);
  const project = await resolveProject(api, flags.project);
  const task = await api.post<Task>("/api/tasks", taskCreateBody(project.id, flags));
  if (flags.json) ctx.out(JSON.stringify(task, null, 2));
  else {
    ctx.out(`Created ${task.id}: ${task.title} (${task.state})`);
    if (task.state === "ready") ctx.out("Ready tasks start automatically when eligible.");
  }
  return task;
}

export function parseStates(v: string | undefined): TaskState[] | undefined {
  if (!v) return undefined;
  const states = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of states) {
    if (!TaskStateSchema.safeParse(s).success) {
      throw new CliError(`Unknown state "${s}". States: ${TaskStateSchema.options.join(", ")}`);
    }
  }
  return states as TaskState[];
}

export async function tasksList(
  ctx: Ctx,
  flags: ListFlags & { state?: string; project?: string; all?: boolean },
): Promise<void> {
  const { api } = connect(ctx, flags);
  const states = parseStates(flags.state);
  const projectId = flags.project ? (await resolveProject(api, flags.project)).id : undefined;
  const q = new URLSearchParams();
  if (states) q.set("state", states.join(","));
  if (projectId) q.set("projectId", projectId);
  if (flags.all) q.set("includeHidden", "true");
  const qs = q.toString();
  const [tasks, projects] = await Promise.all([
    api.get<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`),
    api.get<Project[]>("/api/projects"),
  ]);
  const p = byId(projects);
  printList(
    ctx,
    flags.json,
    tasks,
    ["ID", "STATE", "PRIORITY", "PROJECT", "TITLE"],
    tasks.map((t) => [
      t.id,
      t.blocked ? `${t.state} (blocked)` : t.state,
      PRIORITY_LABELS[t.priority] ?? String(t.priority),
      p.get(t.projectId)?.name ?? t.projectId,
      t.title,
    ]),
    "No tasks.",
  );
}

export async function tasksMove(
  ctx: Ctx,
  id: string,
  to: string,
  flags: ConnectionFlags & { confirm?: boolean; onRunning?: string; json?: boolean },
): Promise<unknown> {
  const [state] = parseStates(to) ?? [];
  if (!state) throw new CliError("Give the target state");
  if (flags.onRunning && flags.onRunning !== "pause" && flags.onRunning !== "stop") {
    throw new CliError("--on-running must be pause or stop");
  }
  const { api } = connect(ctx, flags);
  const body: { to: TaskState; confirm?: boolean; onRunning?: "pause" | "stop" } = { to: state };
  if (flags.confirm) body.confirm = true;
  if (flags.onRunning) body.onRunning = flags.onRunning as "pause" | "stop";
  const res = await api.post<unknown>(`/api/tasks/${encodeURIComponent(id)}/move`, body);
  if (flags.json) ctx.out(JSON.stringify(res, null, 2));
  else {
    const task = (res as { task?: Task } & Partial<Task>)?.task ?? (res as Task);
    ctx.out(`Moved ${task?.title ?? id} to ${task?.state ?? state}`);
  }
  return res;
}

// automations

export async function automationsList(ctx: Ctx, flags: ListFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const list = await api.get<(Automation & { summary?: string })[]>("/api/automations");
  printList(
    ctx,
    flags.json,
    list,
    ["ID", "ENABLED", "NEXT", "NAME", "TRIGGER"],
    list.map((a) => [
      a.id,
      a.enabled ? "yes" : "no",
      a.nextAt ?? "-",
      a.name,
      a.summary ?? a.trigger.kind,
    ]),
    "No automations.",
  );
}

export async function automationsRun(
  ctx: Ctx,
  id: string,
  flags: ConnectionFlags & { json?: boolean },
): Promise<void> {
  const { api } = connect(ctx, flags);
  const res = await api.post<{ occurrence: Occurrence; task: Task | null }>(
    `/api/automations/${encodeURIComponent(id)}/run`,
    {},
  );
  if (flags.json) {
    ctx.out(JSON.stringify(res, null, 2));
    return;
  }
  const o = res.occurrence;
  ctx.out(
    `Occurrence ${o.id}: ${o.state}${o.reason ? ` (${o.reason})` : ""}${
      res.task ? `; task ${res.task.id} "${res.task.title}" is ${res.task.state}` : ""
    }`,
  );
}
