import type { Host, Project, View } from "@switchyard/protocol";
import { findView, openClients } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect, printList } from "../context.js";
import { resolveHost } from "./hosts.js";
import { resolveProject } from "./work.js";

export interface ViewFlags extends ConnectionFlags {
  json?: boolean;
  mode?: "all" | "pinned";
  project?: string[];
  host?: string[];
  anyProject?: boolean;
  anyHost?: boolean;
  name?: string;
}

async function resolveView(api: ApiClient, ref: string): Promise<View> {
  const views = await api.get<View[]>("/api/views");
  const v = findView(views, ref);
  if (v) return v;
  const known = views.map((x) => x.name).join(", ") || "none";
  throw new CliError(`Unknown view "${ref}". Views: ${known}`);
}

function checkMode(mode: string | undefined): void {
  if (mode !== undefined && mode !== "all" && mode !== "pinned") {
    throw new CliError('--mode must be "all" or "pinned"');
  }
}

export async function viewsList(ctx: Ctx, flags: ViewFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const [views, projects, hosts] = await Promise.all([
    api.get<View[]>("/api/views"),
    api.get<Project[]>("/api/projects"),
    api.get<Host[]>("/api/hosts"),
  ]);
  const names = (ids: string[] | null, all: { id: string; name: string }[]) =>
    ids === null ? "any" : ids.map((i) => all.find((x) => x.id === i)?.name ?? i).join(", ") || "-";
  printList(
    ctx,
    flags.json,
    views,
    ["NAME", "MODE", "PROJECTS", "HOSTS", "PINNED", "OPEN IN"],
    views.map((v) => [
      v.name,
      v.mode,
      names(v.projectIds, projects),
      names(v.hostIds, hosts),
      String(v.sessionIds.length),
      openClients(v)
        .map((c) => `${c.kind} ${c.name} (${c.machine})`)
        .join(", ") || "-",
    ]),
    "No views.",
  );
}

async function ids(api: ApiClient, refs: string[] | undefined, kind: "project" | "host") {
  if (!refs || refs.length === 0) return undefined;
  const out: string[] = [];
  for (const r of refs) {
    out.push((kind === "project" ? await resolveProject(api, r) : await resolveHost(api, r)).id);
  }
  return out;
}

export async function viewsCreate(ctx: Ctx, name: string, flags: ViewFlags): Promise<void> {
  checkMode(flags.mode);
  const { api } = connect(ctx, flags);
  const projectIds = await ids(api, flags.project, "project");
  const hostIds = await ids(api, flags.host, "host");
  const v = await api.post<View>("/api/views", {
    name,
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(projectIds ? { projectIds } : {}),
    ...(hostIds ? { hostIds } : {}),
  });
  ctx.out(`Created view ${v.name} (${v.id})`);
}

export async function viewsEdit(ctx: Ctx, ref: string, flags: ViewFlags): Promise<void> {
  checkMode(flags.mode);
  const { api } = connect(ctx, flags);
  const v = await resolveView(api, ref);
  const projectIds = flags.anyProject ? null : await ids(api, flags.project, "project");
  const hostIds = flags.anyHost ? null : await ids(api, flags.host, "host");
  const body = {
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.mode ? { mode: flags.mode } : {}),
    ...(projectIds !== undefined ? { projectIds } : {}),
    ...(hostIds !== undefined ? { hostIds } : {}),
  };
  await api.request<View>("PATCH", `/api/views/${encodeURIComponent(v.id)}`, body);
  ctx.out(`Updated view ${flags.name ?? v.name}`);
}

export async function viewsDelete(ctx: Ctx, ref: string, flags: ViewFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const v = await resolveView(api, ref);
  await api.request("DELETE", `/api/views/${encodeURIComponent(v.id)}`);
  ctx.out(`Deleted view ${v.name}`);
}

export async function viewsPin(
  ctx: Ctx,
  ref: string,
  sessionId: string,
  flags: ViewFlags,
  unpin = false,
): Promise<void> {
  const { api } = connect(ctx, flags);
  const v = await resolveView(api, ref);
  const path = `/api/views/${encodeURIComponent(v.id)}/sessions/${encodeURIComponent(sessionId)}`;
  await api.request(unpin ? "DELETE" : "POST", path);
  ctx.out(`${unpin ? "Unpinned" : "Pinned"} ${sessionId} ${unpin ? "from" : "in"} ${v.name}`);
}
