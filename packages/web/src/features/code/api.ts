import type {
  DiffResult,
  FileEntry,
  ModelStateResult,
  Run,
  Session,
  SessionModel,
  SlashCommand,
  Task,
  ThinkingLevel,
} from "@switchyard/protocol";
import { apiGet, apiPost } from "../../sync/api";

/** REST calls used by the Code feature (paths match packages/coordinator/src/routes). */

const s = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;
const w = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;
const t = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

export type CreateSessionBody = {
  projectId: string;
  workspace:
    | { existingId: string }
    | { checkoutId: string; newBranch: string; base?: string | null };
  profileId?: string | null;
  prompt: string;
  title?: string;
};

export type PromptMode = "prompt" | "steer" | "followUp";

export interface PromptResult {
  ok: boolean;
  clientMessageId: string | null;
  automationActive: boolean;
}

export const codeApi = {
  createSession: (body: CreateSessionBody) => apiPost<Session>("/api/sessions", body),
  prompt: (
    id: string,
    body: {
      text: string;
      mode: PromptMode;
      images?: { mimeType: string; data: string }[];
      clientMessageId?: string;
    },
  ) => apiPost<PromptResult>(`${s(id)}/prompt`, body),
  models: (id: string, signal?: AbortSignal) =>
    apiGet<{ models: SessionModel[] }>(`${s(id)}/models`, undefined, signal),
  commands: (id: string, signal?: AbortSignal) =>
    apiGet<{ commands: SlashCommand[] }>(`${s(id)}/commands`, undefined, signal),
  setModel: (id: string, provider: string, modelId: string) =>
    apiPost<ModelStateResult>(`${s(id)}/model`, { provider, modelId }),
  setThinking: (id: string, level: ThinkingLevel) =>
    apiPost<ModelStateResult>(`${s(id)}/thinking`, { level }),
  compact: (id: string, instructions?: string | null) =>
    apiPost<{ ok: true }>(`${s(id)}/compact`, instructions ? { instructions } : {}),
  abort: (id: string, clearQueue = false) => apiPost(`${s(id)}/abort`, { clearQueue }),
  stop: (id: string) => apiPost<Session>(`${s(id)}/stop`),
  resume: (id: string) => apiPost<Session>(`${s(id)}/resume`),
  takeover: (id: string) => apiPost<{ session: Session; run: Run }>(`${s(id)}/takeover`),
  returnToAutomation: (id: string) =>
    apiPost<{ session: Session; run: Run }>(`${s(id)}/return-to-automation`),
  rename: (id: string, title: string) => apiPost<Session>(`${s(id)}/rename`, { title }),
  archive: (id: string) => apiPost<Session>(`${s(id)}/archive`),
  unarchive: (id: string) => apiPost<Session>(`${s(id)}/unarchive`),
  adapterAction: (id: string, adapterId: string, actionId: string, payload?: unknown) =>
    apiPost<{ ok: boolean; result: unknown }>(`${s(id)}/adapter-action`, {
      adapterId,
      actionId,
      payload,
    }),

  diff: (workspaceId: string, file?: string, signal?: AbortSignal) =>
    apiGet<DiffResult>(`${w(workspaceId)}/diff`, file ? { file } : undefined, signal),
  files: async (workspaceId: string, dir: string, signal?: AbortSignal) =>
    normalizeEntries(await apiGet<unknown>(`${w(workspaceId)}/files`, { dir }, signal)),
  file: async (workspaceId: string, path: string, signal?: AbortSignal) =>
    normalizeFile(await apiGet<unknown>(`${w(workspaceId)}/file`, { path }, signal)),
  refreshWorkspace: (workspaceId: string) => apiPost(`${w(workspaceId)}/refresh`),

  requestChanges: (taskId: string, feedback: string[]) =>
    apiPost<Task>(`${t(taskId)}/request-changes`, { feedback }),
  accept: (taskId: string, confirm?: boolean) =>
    apiPost<Task>(`${t(taskId)}/accept`, confirm ? { confirm: true } : {}),
};

/** `workspace.files` result: an entry array, or `{entries}` / `{files}`. */
export function normalizeEntries(raw: unknown): FileEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { entries?: unknown; files?: unknown } | null)?.entries ??
      (raw as { files?: unknown } | null)?.files ??
      []);
  if (!Array.isArray(list)) return [];
  return (list as FileEntry[])
    .filter((e) => e && typeof e.name === "string")
    .sort((a, b) => {
      const da = a.kind === "dir" ? 0 : 1;
      const db = b.kind === "dir" ? 0 : 1;
      return da - db || a.name.localeCompare(b.name);
    });
}

export interface FileContent {
  text: string | null;
  binary: boolean;
  truncated: boolean;
  size: number | null;
  /** Base64 content of a binary file. */
  base64: string | null;
}

/** `workspace.readFile` result: a string, or `{content|text, binary?, truncated?, size?}`. */
export function normalizeFile(raw: unknown): FileContent {
  if (typeof raw === "string")
    return { text: raw, binary: false, truncated: false, size: null, base64: null };
  const o = (raw ?? {}) as Record<string, unknown>;
  const text =
    typeof o.content === "string" ? o.content : typeof o.text === "string" ? o.text : null;
  return {
    text,
    binary: o.binary === true || (text === null && o.encoding === "base64"),
    truncated: o.truncated === true,
    size: typeof o.size === "number" ? o.size : null,
    base64: o.encoding === "base64" && typeof o.content === "string" ? o.content : null,
  };
}
