import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { SwitchyardClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags, resolveConnection } from "../config.js";
import type { Ctx } from "../context.js";
import { herdrCall } from "./client.js";
import { type MirrorState, spaceLabel } from "./mirror.js";
import { herdrPane } from "./pane.js";
import { type Outcome, type PickItem, Screen, type TerminalIO } from "./picker.js";
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

/** What the picker settled on: the body for `POST /api/sessions` (prompt aside). */
export interface SessionChoice {
  projectId: string;
  workspace: { existingId: string } | { checkoutId: string; newBranch: string };
  title?: string;
}

type WorkspacePick =
  | { kind: "existing"; workspaceId: string }
  | { kind: "new"; checkoutId: string; branch: string | null };

/** Hosts whose agent runs terminal sessions: the only ones a herdr tab can show. */
export function terminalHostIds(st: MirrorState): Set<string> {
  return new Set(st.hosts.filter((h) => h.capabilities?.terminal === true).map((h) => h.id));
}

/** `/Users/me/x` and `/home/me/x` as `~/x`. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** A query typed as a branch name, as a bare slug: `Login retry!` -> `login-retry`. */
export function branchSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._/-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "")
    .replace(/\.lock$/, "");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function liveSessions(st: MirrorState) {
  return st.sessions.filter((x) => x.archivedAt === null && !x.readOnly);
}

function latest(times: string[]): string {
  return [...times].sort().at(-1) ?? "";
}

/** Projects with a terminal-capable workspace or checkout, most recently active first. */
export function projectItems(st: MirrorState): PickItem<string>[] {
  const hosts = terminalHostIds(st);
  const workspaces = st.workspaces.filter((w) => w.archivedAt === null && hosts.has(w.hostId));
  const sessions = liveSessions(st);
  const name = (id: string) => st.hosts.find((h) => h.id === id)?.name ?? id;
  return st.projects
    .map((p) => {
      const hostIds = new Set([
        ...workspaces.filter((w) => w.projectId === p.id).map((w) => w.hostId),
        ...st.checkouts
          .filter((c) => c.projectId === p.id && hosts.has(c.hostId))
          .map((c) => c.hostId),
      ]);
      const own = sessions.filter((x) => x.projectId === p.id);
      const detail = [
        [...hostIds].map(name).sort().join(", "),
        own.length > 0 ? plural(own.length, "session") : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        item: { label: p.name, detail, value: p.id },
        usable: hostIds.size > 0,
        active: latest(own.map((x) => x.lastActivityAt)),
      };
    })
    .filter((x) => x.usable)
    .sort((a, b) => b.active.localeCompare(a.active) || a.item.label.localeCompare(b.item.label))
    .map((x) => x.item);
}

/** A project's workspaces on terminal-capable hosts, most recently active first. */
export function workspaceItems(st: MirrorState, projectId: string): PickItem<WorkspacePick>[] {
  const hosts = terminalHostIds(st);
  const sessions = liveSessions(st);
  const name = (id: string) => st.hosts.find((h) => h.id === id)?.name ?? id;
  return st.workspaces
    .filter((w) => w.projectId === projectId && w.archivedAt === null && hosts.has(w.hostId))
    .map((w) => {
      const own = sessions.filter((x) => x.workspaceId === w.id);
      const detail = [
        name(w.hostId),
        tildePath(w.path),
        own.length > 0 ? plural(own.length, "session") : "",
        w.git?.dirty ? "modified" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const label = `${w.branch ?? basename(w.path)}${w.provenance === "main" ? " (main checkout)" : ""}`;
      return {
        item: { label, detail, value: { kind: "existing", workspaceId: w.id } as WorkspacePick },
        active: latest(own.map((x) => x.lastActivityAt)),
        main: w.provenance === "main",
      };
    })
    .sort(
      (a, b) =>
        b.active.localeCompare(a.active) ||
        Number(b.main) - Number(a.main) ||
        a.item.label.localeCompare(b.item.label),
    )
    .map((x) => x.item);
}

/**
 * "New worktree" entries, one per terminal-capable checkout, always shown after the matches. A
 * typed query becomes the branch name.
 */
export function newWorktreeItems(
  st: MirrorState,
  projectId: string,
  query: string,
): PickItem<WorkspacePick>[] {
  const hosts = terminalHostIds(st);
  const branch = branchSlug(query) || null;
  const name = (id: string) => st.hosts.find((h) => h.id === id)?.name ?? id;
  return st.checkouts
    .filter((c) => c.projectId === projectId && hosts.has(c.hostId))
    .map((c) => ({
      label: branch ? `+ New worktree ${branch}` : "+ New worktree",
      detail: `${name(c.hostId)} · from ${c.defaultBranch} · ${tildePath(c.path)}`,
      value: { kind: "new", checkoutId: c.id, branch },
    }));
}

const HINT_PICK = "↑↓ move · enter select · esc back · ctrl+c cancel";
const HINT_ASK = "enter confirm · esc back · ctrl+c cancel";

/**
 * The new-session steps: project, workspace (an existing one, or a new worktree named by the
 * query), branch name when none was typed, and an optional title. Esc goes back a step; leaving
 * the first step (or Ctrl+C) returns null. With `workspaceId`, starts by offering that workspace.
 */
export async function chooseSession(
  st: MirrorState,
  screen: Screen,
  opts: { workspaceId?: string } = {},
): Promise<SessionChoice | null> {
  const hosts = terminalHostIds(st);
  const projects = projectItems(st);
  const projectName = (id: string) => st.projects.find((p) => p.id === id)?.name ?? id;
  type Step = "here" | "project" | "workspace" | "branch" | "title";
  const here = opts.workspaceId
    ? st.workspaces.find((w) => w.id === opts.workspaceId && w.archivedAt === null)
    : undefined;
  if (opts.workspaceId && !here) throw new CliError(`Workspace ${opts.workspaceId} not found`);
  if (here && !hosts.has(here.hostId)) {
    throw new CliError(`${spaceLabel(here.id, st)}'s host does not run terminal sessions`);
  }
  if (!here && projects.length === 0) {
    throw new CliError("No Switchyard project has a host that runs terminal sessions");
  }
  const steps: Step[] = [here ? "here" : "project"];
  let projectId = here?.projectId ?? "";
  let workspace: WorkspacePick | null = here ? { kind: "existing", workspaceId: here.id } : null;
  let checkoutId = "";
  // What was typed at each step, restored when Esc returns to it.
  const typed: Partial<Record<Step, string>> = {};
  let lastProject = "";
  const crumbs = (): string[] => {
    const c = ["New session"];
    if (projectId) c.push(projectName(projectId));
    const pick = workspace;
    if (pick?.kind === "existing") {
      const w = st.workspaces.find((x) => x.id === pick.workspaceId);
      if (w && w.provenance !== "main") c.push(w.branch ?? basename(w.path));
    } else if (pick?.kind === "new" && pick.branch) {
      c.push(pick.branch);
    }
    return c;
  };
  for (;;) {
    const step = steps[steps.length - 1];
    if (step === undefined) return null;
    let out: Outcome<unknown>;
    if (step === "here") {
      out = await screen.pick(
        { crumbs: crumbs(), heading: "Start a session here?", hint: HINT_PICK },
        [
          { label: `Start a session in ${spaceLabel(here!.id, st)}`, value: "here" },
          { label: "Choose another project or workspace…", value: "other" },
        ],
      );
      if (out.kind === "ok") {
        typed[step] = out.query;
        if (out.value === "here") {
          projectId = here!.projectId;
          workspace = { kind: "existing", workspaceId: here!.id };
          steps.push("title");
        } else {
          projectId = "";
          workspace = null;
          if (projects.length === 0) {
            throw new CliError("No Switchyard project has a host that runs terminal sessions");
          }
          steps.push("project");
        }
        continue;
      }
    } else if (step === "project") {
      projectId = "";
      workspace = null;
      out = await screen.pick(
        { crumbs: crumbs(), heading: "Project", hint: HINT_PICK },
        projects,
        undefined,
        typed.project,
      );
      if (out.kind === "ok") {
        typed[step] = out.query;
        if (out.value !== lastProject) {
          // Another project: its workspace step starts fresh.
          delete typed.workspace;
          delete typed.branch;
        }
        projectId = out.value as string;
        lastProject = projectId;
        steps.push("workspace");
        continue;
      }
    } else if (step === "workspace") {
      workspace = null;
      const items = workspaceItems(st, projectId);
      out = await screen.pick(
        {
          crumbs: crumbs(),
          heading:
            items.length > 0
              ? "Workspace, or type a branch name for a new worktree"
              : "No workspaces yet: type a branch name for a new worktree",
          hint: HINT_PICK,
        },
        items,
        (q) => newWorktreeItems(st, projectId, q),
        typed.workspace,
      );
      if (out.kind === "ok") {
        typed[step] = out.query;
        workspace = out.value as WorkspacePick;
        if (workspace.kind === "new" && !workspace.branch) {
          checkoutId = workspace.checkoutId;
          steps.push("branch");
        } else {
          steps.push("title");
        }
        continue;
      }
    } else if (step === "branch") {
      workspace = null;
      out = await screen.ask(
        { crumbs: crumbs(), heading: "Branch name for the new worktree", hint: HINT_ASK },
        {
          placeholder: "login-retry",
          initial: typed.branch ?? "",
          check: (v) => (branchSlug(v) ? null : "Type a branch name"),
          preview: (v) => {
            const slug = branchSlug(v);
            return slug && slug !== v ? `Branch: ${slug}` : null;
          },
        },
      );
      if (out.kind === "ok") {
        typed[step] = out.query;
        workspace = { kind: "new", checkoutId, branch: branchSlug(out.value as string) };
        steps.push("title");
        continue;
      }
    } else {
      out = await screen.ask(
        {
          crumbs: crumbs(),
          heading: "Title (optional)",
          hint: "enter start · esc back · ctrl+c cancel",
        },
        { placeholder: "Enter to let Pi name it", initial: typed.title ?? "" },
      );
      if (out.kind === "ok") {
        typed[step] = out.query;
        const title = (out.value as string).trim();
        const w = workspace!;
        return {
          projectId,
          workspace:
            w.kind === "existing"
              ? { existingId: w.workspaceId }
              : { checkoutId: w.checkoutId, newBranch: w.branch! },
          ...(title ? { title } : {}),
        };
      }
    }
    if (out.kind === "cancel") return null;
    typed[step] = out.query;
    steps.pop();
  }
}

/**
 * `switchyard herdr new`: start a Switchyard session from a herdr tab. With `--workspace`, offers
 * that workspace first; otherwise picks a project and a workspace (or a new worktree). The tab
 * then becomes the session's tab. Leaving the picker keeps a plain shell.
 */
export async function herdrNew(ctx: Ctx, flags: NewFlags, io?: TerminalIO): Promise<void> {
  if (flags.here) return newHere(ctx);
  ctx.err("Connecting to Switchyard…");
  const { client, state } = await loadMirrorState(ctx, flags);
  const screen = new Screen(
    io ?? {
      input: process.stdin,
      output: process.stdout,
      color: !("NO_COLOR" in ctx.env),
    },
  );
  let created: Session | null = null;
  try {
    const choice = await chooseSession(state(), screen, {
      ...(flags.workspace ? { workspaceId: flags.workspace } : {}),
    });
    screen.leave();
    if (!choice) {
      ctx.err("Kept this tab as a shell.");
      return;
    }
    created = await client.api.post<Session>("/api/sessions", { ...choice, prompt: "" });
    ctx.err(`Starting ${created.title}…`);
  } finally {
    screen.leave();
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
