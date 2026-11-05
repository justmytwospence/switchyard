import { type ApiClient, ApiRequestError } from "@switchyard/terminal";

export type ArchiveResult = { ok: true } | { ok: false; notice: string | null };

/** Archive a session after its tab or window was closed. A notice says why it was kept. */
export async function archiveSession(
  api: ApiClient,
  sessionId: string,
  title: string,
): Promise<ArchiveResult> {
  try {
    await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/archive`);
    return { ok: true };
  } catch (err) {
    const code = err instanceof ApiRequestError ? err.code : null;
    if (code === "conflict") {
      return { ok: false, notice: `${title} is still running: stop it before closing its tab` };
    }
    if (code === "host_unreachable") {
      return { ok: false, notice: `${title}'s host is offline: it was not archived` };
    }
    throw err;
  }
}

export async function renameSession(api: ApiClient, sessionId: string, title: string) {
  await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, { title });
}
