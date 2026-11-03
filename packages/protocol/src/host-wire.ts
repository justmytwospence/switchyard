import { z } from "zod";
import {
  CheckResult,
  GitState,
  Interaction,
  NativeHandle,
  Profile,
  RuntimeCapabilities,
  RuntimeState,
  TranscriptItem,
} from "./entities.js";
import { ErrorBody } from "./errors.js";
import { HostEvent, StreamDelta } from "./events.js";
import { InteractionResponseSchema } from "./ui.js";

const Origin = z.enum(["human", "automation"]);

export const HostCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    sessionId: z.string(),
    title: z.string(),
    workspacePath: z.string(),
    projectId: z.string().nullable(),
    profile: Profile,
    nativeHandle: NativeHandle.nullable(),
    initialPrompt: z.string().nullable(),
    dispatchKey: z.string().nullable(),
    controlRevision: z.number().int(),
    controlMode: z.enum(["automation", "human"]),
    origin: Origin,
    readOnly: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("session.prompt"),
    sessionId: z.string(),
    text: z.string(),
    images: z.array(z.object({ mimeType: z.string(), data: z.string() })).default([]),
    mode: z.enum(["prompt", "steer", "followUp"]),
    origin: Origin,
    controlRevision: z.number().int(),
  }),
  z.object({ type: z.literal("session.abort"), sessionId: z.string(), clearQueue: z.boolean() }),
  z.object({ type: z.literal("session.stop"), sessionId: z.string() }),
  z.object({
    type: z.literal("session.answer"),
    sessionId: z.string(),
    interactionId: z.string(),
    revision: z.number().int(),
    response: InteractionResponseSchema,
    deviceId: z.string(),
  }),
  z.object({
    type: z.literal("session.adapterAction"),
    sessionId: z.string(),
    adapterId: z.string(),
    actionId: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("session.setControl"),
    sessionId: z.string(),
    controlRevision: z.number().int(),
    mode: z.enum(["automation", "human"]),
  }),
  z.object({ type: z.literal("session.rename"), sessionId: z.string(), title: z.string() }),
  z.object({ type: z.literal("session.importable") }),
  z.object({ type: z.literal("session.readNative"), sessionFile: z.string() }),
  z.object({ type: z.literal("session.snapshot"), sessionId: z.string() }),
  z.object({ type: z.literal("checkout.inspect"), path: z.string() }),
  z.object({ type: z.literal("projects.scan"), folder: z.string().min(1) }),
  z.object({
    type: z.literal("workspace.discover"),
    checkoutPath: z.string(),
    worktreeDir: z.string().default(".worktrees"),
  }),
  z.object({
    type: z.literal("workspace.create"),
    checkoutPath: z.string(),
    branch: z.string(),
    base: z.string(),
    setupCommand: z.string().nullable(),
    worktreeDir: z.string().default(".worktrees"),
  }),
  z.object({ type: z.literal("workspace.status"), path: z.string(), base: z.string().nullable() }),
  z.object({
    type: z.literal("workspace.remove"),
    path: z.string(),
    checkoutPath: z.string(),
    base: z.string().nullable(),
    force: z.object({ dirty: z.boolean(), unmerged: z.boolean() }),
  }),
  z.object({
    type: z.literal("workspace.diff"),
    path: z.string(),
    base: z.string().nullable(),
    file: z.string().nullable(),
  }),
  z.object({ type: z.literal("workspace.files"), path: z.string(), dir: z.string() }),
  z.object({ type: z.literal("workspace.readFile"), path: z.string(), file: z.string() }),
  z.object({
    type: z.literal("dispatch.start"),
    dispatchKey: z.string(),
    runId: z.string(),
    taskId: z.string(),
    sessionId: z.string(),
    projectId: z.string(),
    title: z.string(),
    workspace: z.union([
      z.object({ path: z.string() }),
      z.object({
        createFrom: z.object({
          checkoutPath: z.string(),
          branch: z.string(),
          base: z.string(),
          setupCommand: z.string().nullable(),
          worktreeDir: z.string().default(".worktrees"),
        }),
      }),
    ]),
    nativeHandle: NativeHandle.nullable(),
    profile: Profile,
    prompt: z.string(),
    /** The launch's own revision; a takeover always carries a newer one. */
    controlRevision: z.number().int(),
    controlMode: z.enum(["automation", "human"]).default("automation"),
  }),
  z.object({ type: z.literal("dispatch.reconcile"), dispatchKey: z.string() }),
  z.object({
    type: z.literal("checks.run"),
    sessionId: z.string(),
    path: z.string(),
    commands: z.array(z.string()),
  }),
]);
export type HostCommand = z.infer<typeof HostCommand>;
export type HostCommandType = HostCommand["type"];
export type HostCommandOf<T extends HostCommandType> = Extract<HostCommand, { type: T }>;

/** Result payloads for commands that return data. */
export const ImportableSession = z.object({
  sessionFile: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  name: z.string().nullable(),
  mtime: z.string(),
  inactive: z.boolean(),
});
export type ImportableSession = z.infer<typeof ImportableSession>;

export const DiscoveredWorktree = z.object({
  path: z.string(),
  head: z.string().nullable(),
  branch: z.string().nullable(),
  bare: z.boolean(),
  detached: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  provenance: z.enum(["managed", "discovered", "main"]),
  git: GitState.nullable(),
});
export type DiscoveredWorktree = z.infer<typeof DiscoveredWorktree>;

export const CheckoutInfo = z.object({
  root: z.string(),
  commonDir: z.string(),
  repoIdentity: z.string(),
  defaultBranch: z.string(),
});
export type CheckoutInfo = z.infer<typeof CheckoutInfo>;

export const ScannedRepository = CheckoutInfo.extend({ name: z.string() });
export type ScannedRepository = z.infer<typeof ScannedRepository>;

export const ProjectFolderScan = z.object({
  /** The folder, ~ expanded and realpath'd. */
  folder: z.string(),
  repositories: z.array(ScannedRepository),
});
export type ProjectFolderScan = z.infer<typeof ProjectFolderScan>;

export const DiffFile = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  added: z.number().int(),
  deleted: z.number().int(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked", "binary"]),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const DiffResult = z.object({
  base: z.string(),
  files: z.array(DiffFile),
  patch: z.string().nullable(),
});
export type DiffResult = z.infer<typeof DiffResult>;

export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "dir", "symlink"]),
  size: z.number().int().nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const ReconcileResult = z.union([
  z.object({ known: z.literal(false) }),
  z.object({
    known: z.literal(true),
    sessionId: z.string().nullable(),
    state: z.enum(["accepted", "workspace_ready", "started", "failed"]),
    runtime: RuntimeState.nullable(),
    workspacePath: z.string().nullable(),
    nativeHandle: NativeHandle.nullable(),
    error: z.string().nullable(),
    /** `{started: "unknown"}` when the host restarted after Pi may have been spawned. */
    errorDetails: z.record(z.string(), z.unknown()).nullable().default(null),
  }),
]);
export type ReconcileResult = z.infer<typeof ReconcileResult>;

export const DispatchStartResult = z.object({
  sessionId: z.string(),
  workspacePath: z.string(),
  nativeHandle: NativeHandle.nullable(),
  reused: z.boolean(),
});
export type DispatchStartResult = z.infer<typeof DispatchStartResult>;

export const AnswerResult = z.object({
  status: z.enum(["answered", "already_answered"]),
  interaction: Interaction,
});
export type AnswerResult = z.infer<typeof AnswerResult>;

export const SnapshotResult = z.object({
  partial: z.array(TranscriptItem),
  pendingInteractions: z.array(Interaction),
});
export type SnapshotResult = z.infer<typeof SnapshotResult>;

export const ChecksResult = z.object({ results: z.array(CheckResult) });
export type ChecksResult = z.infer<typeof ChecksResult>;

export const Receipt = z.union([
  z.object({ commandId: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ commandId: z.string(), ok: z.literal(false), error: ErrorBody }),
]);
export type Receipt = z.infer<typeof Receipt>;

/** Host -> coordinator frames. */
export const HostToCoordinator = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    hostId: z.string(),
    credential: z.string(),
    name: z.string(),
    agentVersion: z.string(),
    piVersion: z.string().nullable(),
    piCompatible: z.boolean(),
    platform: z.enum(["darwin", "linux"]),
    capabilities: RuntimeCapabilities.nullable(),
    protocolVersion: z.number().int(),
  }),
  z.object({ type: z.literal("event"), hostSeq: z.number().int(), event: HostEvent }),
  z.object({ type: z.literal("stream"), delta: StreamDelta }),
  z.object({ type: z.literal("receipt"), receipt: Receipt }),
  z.object({ type: z.literal("pong") }),
]);
export type HostToCoordinator = z.infer<typeof HostToCoordinator>;

/** Coordinator -> host frames. */
export const CoordinatorToHost = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    coordinatorVersion: z.string(),
    ackedHostSeq: z.number().int(),
  }),
  z.object({ type: z.literal("ack"), hostSeq: z.number().int() }),
  z.object({ type: z.literal("command"), commandId: z.string(), command: HostCommand }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("reject"), error: ErrorBody }),
]);
export type CoordinatorToHost = z.infer<typeof CoordinatorToHost>;
