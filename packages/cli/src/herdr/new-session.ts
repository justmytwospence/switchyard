import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Session } from "@switchyard/protocol";
import { SwitchyardClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags, resolveConnection } from "../config.js";
import type { Ctx } from "../context.js";
import { herdrCall } from "./client.js";
import { type MirrorState, spaceLabel } from "./mirror.js";
import { herdrPane } from "./pane.js";
import { launcherCommand, runInPane, sessionStateDir, stableLauncherPath } from "./util.js";

/** Connect a live client and read the mirror's view of Switchyard. */
export async function loadMirrorState(
  ctx: Ctx,
  flags: ConnectionFlags,
  timeoutMs = 15_000,
): Promise<{ client: SwitchyardClient; state: () => MirrorState }> {
  const conn = resolveConnection(flags, ctx.env, ctx.paths);
  const client = new SwitchyardClient({ coordinatorUrl: conn.url, credential: conn.credential });
  client.connect();
  await new Promise<void>((resolve, reject) => {
    if (client.store.getState().synced) return resolve();
    const timer = setTimeout(() => {
      off();
      client.close();
      reject(new CliError("Switchyard is not reachable"));
    }, timeoutMs);
    const off = client.onLive(() => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  return { client, state: () => mirrorStateOf(client) };
}

export function mirrorStateOf(client: SwitchyardClient): MirrorState {
  const s = client.store.getState();
  return {
    sessions: Object.values(s.sessions),
    workspaces: Object.values(s.workspaces),
    projects: Object.values(s.projects),
    hosts: Object.values(s.hosts),
    checkouts: Object.values(s.checkouts),
  };
}

export interface NewFlags extends ConnectionFlags {
  workspace?: string;
  here?: boolean;
}

/**
 * `switchyard herdr new`: start a Switchyard session from a herdr tab. With `--workspace`, asks for
 * a title; otherwise picks a project and a workspace (or a new worktree). The tab then becomes the
 * session's tab. Declining leaves a plain shell.
 */
export async function herdrNew(ctx: Ctx, flags: NewFlags): Promise<void> {
  if (flags.here) return newHere(ctx);
  const { client, state } = await loadMirrorState(ctx, flags);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let created: Session | null = null;
  try {
    const st = state();
    const workspaces = st.workspaces.filter((w) => w.archivedAt === null);
    const hostName = (id: string) => st.hosts.find((h) => h.id === id)?.name ?? id;
    let body: Record<string, unknown>;
    if (flags.workspace) {
      const w = workspaces.find((x) => x.id === flags.workspace);
      if (!w) throw new CliError(`Workspace ${flags.workspace} not found`);
      const yes = (
        await rl.question(`Start a Switchyard session in ${spaceLabel(w.id, st)}? [Y/n] `)
      )
        .trim()
        .toLowerCase();
      if (yes === "n" || yes === "no") return;
      body = { projectId: w.projectId, workspace: { existingId: w.id } };
    } else {
      const projects = [...st.projects].sort((a, b) => a.name.localeCompare(b.name));
      if (projects.length === 0) throw new CliError("Switchyard has no projects yet");
      ctx.out("New Switchyard session");
      for (const [i, p] of projects.entries()) ctx.out(`  ${i + 1}) ${p.name}`);
      const pi = (
        await rl.question(`Project [1-${projects.length}], Enter keeps this tab as a shell: `)
      ).trim();
      if (!pi) return;
      const project = projects[Number(pi) - 1];
      if (!project) throw new CliError(`No project ${pi}`);
      const own = workspaces.filter((w) => w.projectId === project.id);
      for (const [i, w] of own.entries()) {
        ctx.out(`  ${i + 1}) ${w.branch ?? "main"} (${hostName(w.hostId)})  ${w.path}`);
      }
      ctx.out("  n) new worktree");
      const wi = (await rl.question("Workspace: ")).trim().toLowerCase();
      if (wi === "n") {
        const checkouts = st.checkouts.filter((c) => c.projectId === project.id);
        if (checkouts.length === 0) throw new CliError(`${project.name} has no checkouts`);
        let checkout = checkouts[0]!;
        if (checkouts.length > 1) {
          for (const [i, c] of checkouts.entries())
            ctx.out(`  ${i + 1}) ${hostName(c.hostId)}  ${c.path}`);
          const hi = (await rl.question("Host: ")).trim();
          checkout = checkouts[Number(hi) - 1] ?? checkout;
        }
        const branch = (await rl.question("Branch name: ")).trim();
        if (!branch) throw new CliError("A new worktree needs a branch name");
        body = { projectId: project.id, workspace: { checkoutId: checkout.id, newBranch: branch } };
      } else {
        const w = own[Number(wi) - 1];
        if (!w) throw new CliError(`No workspace ${wi}`);
        body = { projectId: project.id, workspace: { existingId: w.id } };
      }
    }
    const title = (await rl.question("Title (optional): ")).trim();
    created = await client.api.post<Session>("/api/sessions", {
      ...body,
      prompt: "",
      ...(title ? { title } : {}),
    });
    ctx.err(`Starting ${created.title}…`);
  } finally {
    rl.close();
    client.close();
  }
  if (created) await herdrPane(ctx, created.id, flags);
}

/** The `new` action: a new tab in the focused space, running the picker. */
async function newHere(ctx: Ctx): Promise<void> {
  const call = (method: string, params: Record<string, unknown>) => herdrCall(method, params);
  const snap = (await call("session.snapshot", {}))?.snapshot ?? {};
  const ws: string | undefined = snap.focused_workspace_id;
  let key: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(sessionStateDir(ctx.env), "spaces.json"), "utf8"));
    key = ws ? (raw.spaces?.[ws]?.key ?? null) : null;
  } catch {
    key = null;
  }
  const r = await call("tab.create", { ...(ws ? { workspace_id: ws } : {}), focus: true });
  const paneId = r?.root_pane?.pane_id;
  if (!paneId) throw new CliError("herdr did not open a tab");
  const args = key && !key.startsWith("cwd:") ? ["new", "--workspace", key] : ["new"];
  await runInPane(call, paneId, launcherCommand(stableLauncherPath(ctx.env), args));
}
