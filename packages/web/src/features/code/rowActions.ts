import { isInputAttentionReason, type Session } from "@switchyard/protocol";
import { toast, useToasts } from "../../components/ui/Toast";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "./api";
import { dismissAttentionItem } from "./SessionActions";

/** Archive without a confirmation (a swipe); Undo in the toast brings it back. */
export async function archiveWithUndo(session: Session): Promise<void> {
  try {
    await codeApi.archive(session.id);
  } catch (e) {
    toast.error(errorMessage(e));
    throw e;
  }
  useToasts.getState().push(
    {
      tone: "success",
      message: `Archived "${session.title}"`,
      action: {
        label: "Undo",
        onClick: () =>
          void codeApi.unarchive(session.id).catch((e) => toast.error(errorMessage(e))),
      },
    },
    6000,
  );
}

/** Clear the session's "Needs input" flag (a question Pi still waits on stays). */
export async function clearNeedsInput(sessionId: string): Promise<void> {
  const items = Object.values(useSyncStore.getState().attention).filter(
    (a) => a.sessionId === sessionId && !a.resolvedAt && isInputAttentionReason(a.reason),
  );
  try {
    await Promise.all(items.map(dismissAttentionItem));
    toast.success("Cleared Needs input");
  } catch (e) {
    toast.error(errorMessage(e));
  }
}
