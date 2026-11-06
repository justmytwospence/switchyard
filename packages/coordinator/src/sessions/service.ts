import {
  type Checkout,
  type HostCommandOf,
  type NativeHandle,
  newId,
  type Profile,
  type Project,
  type Session,
  SwitchyardError,
  type TranscriptItem,
  titleFrom,
  type Workspace,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import { predictedWorktreePath, recordCreatedWorkspace, worktreeDirOf } from "../workspaces.js";

export const LIVE_RUNTIMES: Session["runtime"][] = ["starting", "idle", "running", "waiting_input"];

/** Throws `host_unreachable` / `pi_incompatible` unless the host can start sessions. */
export function requireUsableHost(ctx: CoordinatorContext, hostId: string): void {
  const host = ctx.store.hosts.require(hostId);
  if (host.revokedAt) throw new SwitchyardError("forbidden", `Host ${host.name} was revoked`);
  if (!ctx.hostHub.isConnected(hostId)) {
    throw new SwitchyardError("host_unreachable", `Host ${host.name} is offline`, { hostId });
  }
  if (!host.piCompatible) {
    throw new SwitchyardError(
      "pi_incompatible",
      `Pi ${host.piVersion ?? "(not found)"} on ${host.name} is outside the tested range`,
      { hostId },
    );
  }
}

/** Requires a connected host (any Pi version), for non-session commands. */
export function requireConnected(ctx: CoordinatorContext, hostId: string): void {
  const host = ctx.store.hosts.require(hostId);
  if (!ctx.hostHub.isConnected(hostId)) {
    throw new SwitchyardError("host_unreachable", `Host ${host.name} is offline`, { hostId });
  }
}

/** Profile by id, else the project default, else the first (seeded "Default"). */
export function resolveProfile(
  ctx: CoordinatorContext,
  profileId: string | null | undefined,
  project?: Project | null,
): Profile {
  const id = profileId ?? project?.defaultProfileId ?? null;
  if (id) return ctx.store.profiles.require(id);
  const first = ctx.store.profiles.list(undefined, [], "created_at, rowid")[0];
  if (!first) throw new SwitchyardError("invalid_request", "No Pi profile configured");
  return first;
}

/** Append a coordinator-authored notice to a session transcript. */
export function appendNotice(
  ctx: CoordinatorContext,
  session: Session,
  level: "info" | "warning" | "error",
  text: string,
): TranscriptItem {
  return ctx.store.tx(() => {
    const item: TranscriptItem = {
      id: newId("itm"),
      sessionId: session.id,
      order: ctx.store.maxItemOrder(session.id) + 1,
      at: ctx.store.nowIso(),
      kind: "notice",
      data: { level, text },
    };
    ctx.store.upsertItem(item);
    ctx.store.appendEvent(
      "transcript.item",
      { sessionId: session.id, hostId: session.hostId, projectId: session.projectId ?? undefined },
      item,
    );
    return item;
  });
}

/**
 * Replace a session's transcript after a rewind: bumps the epoch so clients drop cached copies.
 * Returns the new epoch.
 */
export function resetTranscript(
  ctx: CoordinatorContext,
  sessionId: string,
  items: TranscriptItem[],
): number {
  return ctx.store.tx(() => {
    ctx.store.replaceItems(sessionId, items);
    const cur = ctx.store.sessions.require(sessionId);
    const epoch = (cur.transcriptEpoch ?? 0) + 1;
    ctx.store.putSession({ ...cur, transcriptEpoch: epoch });
    ctx.store.appendEvent(
      "transcript.reset",
      { sessionId, hostId: cur.hostId, projectId: cur.projectId ?? undefined },
      { sessionId, epoch },
    );
    return epoch;
  });
}

/** Mark a session failed with an error notice (no optimistic success). */
export function failSession(ctx: CoordinatorContext, sessionId: string, message: string): void {
  ctx.store.tx(() => {
    const s = ctx.store.sessions.get(sessionId);
    if (!s) return;
    ctx.store.putSession({
      ...s,
      runtime: "failed",
      runtimeDetail: message,
      lastActivityAt: ctx.store.nowIso(),
    });
    appendNotice(ctx, s, "error", message);
  });
}

export interface StartOptions {
  initialPrompt: string | null;
  nativeHandle: NativeHandle | null;
  controlRevision?: number;
  controlMode?: "automation" | "human";
  origin?: "human" | "automation";
  dispatchKey?: string | null;
}

/** Send `session.start` for a stored session and apply the receipt. */
export async function startOnHost(
  ctx: CoordinatorContext,
  session: Session,
  opts: StartOptions,
): Promise<Session> {
  const cmd: HostCommandOf<"session.start"> = {
    type: "session.start",
    sessionId: session.id,
    title: session.title,
    workspacePath: session.cwd,
    projectId: session.projectId,
    profile: session.profileSnapshot,
    nativeHandle: opts.nativeHandle,
    initialPrompt: opts.initialPrompt,
    dispatchKey: opts.dispatchKey ?? null,
    controlRevision: opts.controlRevision ?? 1,
    controlMode: opts.controlMode ?? "human",
    origin: opts.origin ?? "human",
    readOnly: session.readOnly,
  };
  const result = await ctx.hostHub.request<{ nativeHandle?: NativeHandle | null } | undefined>(
    session.hostId,
    cmd,
  );
  return ctx.store.tx(() => {
    const s = ctx.store.sessions.require(session.id);
    const handle = result?.nativeHandle ?? null;
    if (handle && JSON.stringify(handle) !== JSON.stringify(s.nativeHandle)) {
      return ctx.store.putSession({ ...s, nativeHandle: handle });
    }
    return s;
  });
}

export type WorkspaceChoice =
  | { existingId: string }
  | { checkoutId: string; newBranch: string; base?: string | null };

/** Create a workspace through the host and record it. */
export async function createWorkspace(
  ctx: CoordinatorContext,
  project: Project,
  checkout: Checkout,
  branch: string,
  base: string | null | undefined,
): Promise<Workspace> {
  requireConnected(ctx, checkout.hostId);
  const baseBranch = base ?? checkout.defaultBranch;
  const result = await ctx.hostHub.request<Record<string, unknown> | undefined>(checkout.hostId, {
    type: "workspace.create",
    checkoutPath: checkout.path,
    branch,
    base: baseBranch,
    setupCommand: project.setupCommand,
    worktreeDir: worktreeDirOf(project),
  });
  const predicted = predictedWorktreePath(checkout, project, branch);
  return recordCreatedWorkspace(ctx, project, checkout, {
    path: typeof result?.path === "string" ? result.path : predicted,
    branch: typeof result?.branch === "string" ? result.branch : branch,
    baseBranch,
    git: result?.git,
    setup: result?.setup,
  });
}

/**
 * `POST /api/sessions`: validate, record the session as `starting`, return it, then create the
 * workspace if needed and start Pi in the background. Failures mark the session `failed`.
 */
export function createSession(
  ctx: CoordinatorContext,
  input: {
    projectId: string;
    workspace: WorkspaceChoice;
    profileId?: string | null;
    prompt: string;
    title?: string;
  },
): { session: Session; started: Promise<void> } {
  const project = ctx.store.projects.require(input.projectId);
  const profile = resolveProfile(ctx, input.profileId, project);
  let hostId: string;
  let workspace: Workspace | null = null;
  let checkout: Checkout | null = null;
  if ("existingId" in input.workspace) {
    workspace = ctx.store.workspaces.require(input.workspace.existingId);
    if (workspace.projectId !== project.id) {
      throw new SwitchyardError("invalid_request", "Workspace belongs to another project");
    }
    if (workspace.archivedAt) throw new SwitchyardError("conflict", "Workspace is archived");
    hostId = workspace.hostId;
  } else {
    checkout = ctx.store.checkouts.require(input.workspace.checkoutId);
    if (checkout.projectId !== project.id) {
      throw new SwitchyardError("invalid_request", "Checkout belongs to another project");
    }
    hostId = checkout.hostId;
  }
  requireUsableHost(ctx, hostId);
  const now = ctx.store.nowIso();
  const host = ctx.store.hosts.require(hostId);
  const session: Session = {
    id: newId("ses"),
    title: input.title?.trim() || titleFrom(input.prompt),
    subtitle: null,
    hostId,
    workspaceId: workspace?.id ?? null,
    projectId: project.id,
    cwd:
      workspace?.path ??
      predictedWorktreePath(
        checkout!,
        project,
        (input.workspace as { newBranch: string }).newBranch,
      ),
    nativeHandle: null,
    profileSnapshot: profile,
    runtime: "starting",
    runtimeDetail: workspace ? "Starting Pi…" : "Creating worktree…",
    connectivity: host.connectivity,
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: now,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: now,
  };
  ctx.store.putSession(session);
  const choice = input.workspace;
  const started = (async () => {
    const t0 = Date.now();
    try {
      let s = session;
      if (!("existingId" in choice)) {
        const ws = await createWorkspace(ctx, project, checkout!, choice.newBranch, choice.base);
        ctx.log.info(
          { sessionId: session.id, ms: Date.now() - t0 },
          "session start: worktree ready",
        );
        s = ctx.store.tx(() => {
          const cur = ctx.store.sessions.require(session.id);
          return ctx.store.putSession({
            ...cur,
            workspaceId: ws.id,
            cwd: ws.path,
            runtimeDetail: "Starting Pi…",
          });
        });
      }
      await startOnHost(ctx, s, {
        initialPrompt: input.prompt.trim() ? input.prompt : null,
        nativeHandle: null,
      });
      ctx.log.info(
        { sessionId: session.id, ms: Date.now() - t0 },
        "session start: started on host",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err, sessionId: session.id }, "session start failed");
      failSession(ctx, session.id, `Could not start the session: ${message}`);
    }
  })();
  return { session, started };
}
