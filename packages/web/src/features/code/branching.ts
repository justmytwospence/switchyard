import type { Session } from "@switchyard/protocol";
import { useNavigate } from "react-router";
import { loadDraft, setDraftNow } from "../../drafts";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import { rememberInitialPrompt } from "./startingPrompts";
import { useSelectedView } from "./views";

/** Whether a prefill goes into the draft: only when there is one and the draft is empty. */
export function prefillDecision(draft: string, prefill: string | null): "set" | "kept" | "none" {
  if (!prefill) return "none";
  return draft.trim() === "" ? "set" : "kept";
}

/** Put a rewound message back in the composer unless a draft is already there. */
export function applyPrefill(sessionId: string, prefill: string | null) {
  const d = prefillDecision(loadDraft(sessionId), prefill);
  if (d === "set" && prefill) setDraftNow(sessionId, prefill);
  return d;
}

/** Open the session a fork or clone produced (or start a new one when nothing was written). */
export function useOpenBranch(session: Session) {
  const navigate = useNavigate();
  const [selectedView] = useSelectedView();
  const views = useSyncStore((st) => st.views);
  const openSession = (id: string) => navigate(`/code/${encodeURIComponent(id)}`);
  const startNew = async (prompt: string): Promise<Session> => {
    if (!session.projectId || !session.workspaceId) {
      throw new Error("This session has no project workspace");
    }
    const s = await codeApi.createSession({
      projectId: session.projectId,
      workspace: { existingId: session.workspaceId },
      prompt,
      ...(selectedView && views[selectedView] ? { viewId: selectedView } : {}),
    });
    useSyncStore.getState().upsertSessionIfMissing(s);
    if (prompt) rememberInitialPrompt(s.id, prompt);
    return s;
  };
  return async (r: { session: Session | null; prefill: string | null }) => {
    if (r.session) {
      useSyncStore.getState().upsertSessionIfMissing(r.session);
      if (r.prefill) setDraftNow(r.session.id, r.prefill);
      void codeApi.resume(r.session.id).catch(() => {});
      openSession(r.session.id);
      return;
    }
    const s = await startNew("");
    setDraftNow(s.id, r.prefill ?? "");
    openSession(s.id);
  };
}

/** Whether Rewind and Re-answer are offered for this session at all. */
export function canNavigate(
  session: Pick<Session, "terminal" | "readOnly">,
  host:
    | { capabilities?: { treeNavigation?: boolean; sessionControls?: boolean } | null }
    | undefined,
): boolean {
  return (
    host?.capabilities?.sessionControls === true &&
    host.capabilities.treeNavigation === true &&
    session.terminal === true &&
    !session.readOnly
  );
}
