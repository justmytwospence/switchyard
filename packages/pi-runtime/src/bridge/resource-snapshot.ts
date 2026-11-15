import { isAbsolute } from "node:path";

/** Configured tools/commands report sources, not a complete loaded-extension inventory. */
export interface ResourceSnapshotData {
  cwd: string;
  projectTrusted: boolean | null;
  reportedExtensionPaths: string[];
  hasEditorDraft: boolean;
  pendingDialogs: number;
}

type Source = { sourceInfo?: { path?: string } };
type SnapshotPi = {
  getAllTools?: () => readonly Source[];
  getCommands?: () => readonly (Source & { source?: string })[];
};
type SnapshotContext = {
  cwd: string;
  isProjectTrusted?: () => boolean;
  ui?: { getEditorText?: () => string };
};

/** Only provenance and guard booleans cross the bridge; never settings or draft contents. */
export function resourceSnapshot(
  pi: SnapshotPi,
  ctx: SnapshotContext,
  pendingDialogs = 0,
): ResourceSnapshotData {
  const paths = new Set<string>();
  const add = (source: Source) => {
    const path = source.sourceInfo?.path;
    if (typeof path === "string" && !path.startsWith("builtin:") && isAbsolute(path)) {
      if (path.length > 4096) throw new Error("Resource path exceeds 4096 characters");
      paths.add(path);
      if (paths.size > 2048) throw new Error("Resource snapshot exceeds 2048 paths");
    }
  };
  for (const tool of pi.getAllTools?.() ?? []) add(tool);
  for (const command of pi.getCommands?.() ?? []) {
    if (command.source === "extension") add(command);
  }
  let projectTrusted: boolean | null = null;
  try {
    const trust = ctx.isProjectTrusted?.();
    if (typeof trust === "boolean") projectTrusted = trust;
  } catch {
    // Unknown trust must never authorize project discovery.
  }
  let hasEditorDraft = true;
  try {
    const text = ctx.ui?.getEditorText?.();
    if (typeof text === "string") hasEditorDraft = text.length > 0;
  } catch {
    // Inspection remains available; a full reload must fail closed without a draft guard.
  }
  return {
    cwd: ctx.cwd,
    projectTrusted,
    reportedExtensionPaths: [...paths].sort(),
    hasEditorDraft,
    pendingDialogs,
  };
}
