import type { Host, ProjectScan, ProjectScanResult } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { ago, type Ctx, connect, printList } from "../context.js";
import type { ListFlags } from "./work.js";

/** Accept a host id or a (case-insensitive) unique host name; revoked hosts are ignored. */
export async function resolveHost(api: ApiClient, ref: string): Promise<Host> {
  const hosts = (await api.get<Host[]>("/api/hosts")).filter((h) => !h.revokedAt);
  const exact = hosts.find((h) => h.id === ref);
  if (exact) return exact;
  const named = hosts.filter((h) => h.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new CliError(`Several hosts are named "${ref}"; use the id`);
  const known = hosts.map((h) => `${h.name} (${h.id})`).join(", ") || "none";
  throw new CliError(`Unknown host "${ref}". Hosts: ${known}`);
}

/** One line (plus error lines) describing a host's last project folder scan. */
export function scanLine(scan: ProjectScan | null | undefined, now = Date.now()): string[] {
  if (!scan) return ["Not scanned yet."];
  if (scan.state === "running") return [`Scanning since ${ago(scan.startedAt, now)}.`];
  if (scan.state === "failed") {
    return [
      `Last scan failed ${ago(scan.finishedAt, now)}: ${scan.errors.at(-1) ?? "unknown error"}`,
    ];
  }
  return [
    `Last scanned ${ago(scan.finishedAt, now)}: ${scan.repositories} repositories, ${scan.checkoutsAdded} new checkouts, ${scan.projectsCreated} new projects.`,
    ...scan.errors.map((e) => `! ${e}`),
  ];
}

export async function hostsList(ctx: Ctx, flags: ListFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const hosts = (await api.get<Host[]>("/api/hosts")).filter((h) => !h.revokedAt);
  printList(
    ctx,
    flags.json,
    hosts,
    ["ID", "NAME", "STATUS", "AGENT", "PROJECT FOLDERS"],
    hosts.map((h) => [
      h.id,
      h.name,
      h.connectivity,
      h.agentVersion,
      (h.projectFolders ?? []).join(", ") || "-",
    ]),
    "No hosts.",
  );
}

export interface FoldersFlags extends ConnectionFlags {
  set?: string[];
  add?: string[];
  remove?: string[];
  clear?: boolean;
  json?: boolean;
}

export async function hostsFolders(ctx: Ctx, ref: string, flags: FoldersFlags): Promise<Host> {
  const { api } = connect(ctx, flags);
  const changing = !!(flags.set || flags.add || flags.remove || flags.clear);
  if (
    (flags.set && (flags.add || flags.remove || flags.clear)) ||
    (flags.clear && (flags.add || flags.remove))
  ) {
    throw new CliError("Use --set or --clear on its own, or --add/--remove");
  }
  const host = await resolveHost(api, ref);
  const current = host.projectFolders ?? [];
  if (!changing) {
    if (flags.json) ctx.out(JSON.stringify(host, null, 2));
    else {
      if (current.length === 0) ctx.out("No project folders.");
      for (const f of current) ctx.out(f);
      for (const l of scanLine(host.projectScan)) ctx.out(l);
    }
    return host;
  }
  let next: string[];
  if (flags.set) next = [...flags.set];
  else if (flags.clear) next = [];
  else {
    next = [...current];
    for (const f of flags.remove ?? []) {
      if (!next.includes(f)) throw new CliError(`${f} is not a project folder of ${host.name}`);
      next = next.filter((x) => x !== f);
    }
    for (const f of flags.add ?? []) if (!next.includes(f)) next.push(f);
  }
  const updated = await api.request<Host>("PATCH", `/api/hosts/${encodeURIComponent(host.id)}`, {
    projectFolders: next,
  });
  if (flags.json) {
    ctx.out(JSON.stringify(updated, null, 2));
    return updated;
  }
  const folders = updated.projectFolders ?? [];
  ctx.out(`Project folders on ${updated.name}: ${folders.join(", ") || "none"}`);
  if (folders.length > 0 && updated.connectivity === "connected") {
    ctx.out(
      `Scanning in the background; \`switchyard hosts scan ${updated.name}\` waits for the result.`,
    );
  }
  return updated;
}

export async function hostsScan(
  ctx: Ctx,
  ref: string,
  flags: ListFlags,
): Promise<ProjectScanResult> {
  const { api } = connect(ctx, flags);
  const host = await resolveHost(api, ref);
  const r = await api.post<ProjectScanResult>(
    `/api/hosts/${encodeURIComponent(host.id)}/scan-projects`,
  );
  if (flags.json) {
    ctx.out(JSON.stringify(r, null, 2));
    return r;
  }
  ctx.out(
    `Scanned ${host.name}: ${r.repositories} repositories, ${r.checkoutsAdded} new checkouts, ${r.projectsCreated} new projects`,
  );
  for (const a of r.added) ctx.out(`+ ${a.name}  ${a.path}${a.newProject ? " (new project)" : ""}`);
  for (const e of r.errors) ctx.out(`! ${e}`);
  return r;
}
