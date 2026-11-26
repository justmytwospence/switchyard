import {
  type AttentionItem,
  isInputAttentionReason,
  primarySession,
  type TrackedIssue,
} from "@switchyard/protocol";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { apiDelete, apiPost, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { unlinkIssue } from "../workboard/api";
import { LinkIssueDialog, useIssueLink } from "../workboard/LinkIssue";
import { codeApi } from "./api";
import type { SessionContext } from "./hooks";
import { useMutation } from "./hooks";
import { isBusy, isLive } from "./model";
import { SessionInfoDialog } from "./SessionInfoDialog";

export interface SessionActions {
  canTakeover: boolean;
  canReturn: boolean;
  canStop: boolean;
  canResume: boolean;
  /** Why archive is unavailable, or null. */
  archiveBlocked: string | null;
  takeover: () => void;
  returnToAutomation: () => void;
  requestStop: () => void;
  resume: () => void;
  openRename: () => void;
  requestArchive: () => void;
  openInfo: () => void;
  toggleCacheAlert: () => void;
  unarchive: () => void;
  /** Clear this session's "Needs input" flag (its open input attention), or null when it has none. */
  dismissAttention: (() => void) | null;
  /** Pin the session to a view, or unpin it. */
  setPinned: (viewId: string, pinned: boolean) => void;
  /** This session is its branch's primary session. */
  isPrimary: boolean;
  setPrimary: (primary: boolean) => void;
  /** Start another session in this session's workspace, or null when it has none. */
  newInBranch: (() => void) | null;
  /** Link this worktree's branch to an issue, or undo it; null without a worktree. */
  issueLink: {
    linked: TrackedIssue | null;
    candidates: TrackedIssue[];
    canUnlink: boolean;
    open: () => void;
    unlink: () => void;
  } | null;
  busy: { takeover: boolean; ret: boolean; stop: boolean; resume: boolean; unarchive: boolean };
  /** Confirmation and form dialogs; render once in the view. */
  dialogs: ReactNode;
}

/** Session control and menu actions with confirmation dialogs (no optimistic success). */
export function useSessionActions(ctx: SessionContext): SessionActions {
  const { session, run, control } = ctx;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | "stop" | "rename" | "archive" | "info" | "link">(
    null,
  );
  const [title, setTitle] = useState(session.title);
  const link = useIssueLink(session.provenance === "subagent" ? null : ctx.workspace);
  const attention = useSyncStore((st) => st.attention);
  const inputAttention = useMemo(
    () =>
      Object.values(attention).filter(
        (a) => a.sessionId === session.id && !a.resolvedAt && isInputAttentionReason(a.reason),
      ),
    [attention, session.id],
  );
  const isPrimary = useSyncStore((st) => {
    if (session.provenance === "subagent" || session.archivedAt) return false;
    const peers = Object.values(st.sessions).filter(
      (x) =>
        x.archivedAt === null &&
        x.provenance !== "subagent" &&
        (session.workspaceId
          ? x.workspaceId === session.workspaceId
          : x.workspaceId === null && x.hostId === session.hostId && x.cwd === session.cwd),
    );
    return primarySession(peers)?.id === session.id;
  });

  const takeover = useMutation(() => codeApi.takeover(session.id), {
    success: "You have control. Automatic continuations are paused.",
    errorToast: true,
  });
  const ret = useMutation(() => codeApi.returnToAutomation(session.id), {
    success: "Returned to automation.",
    errorToast: true,
  });
  const stop = useMutation(() => codeApi.stop(session.id), { success: "Session stopped." });
  const resume = useMutation(() => codeApi.resume(session.id), {
    success: "Session resumed.",
    errorToast: true,
  });
  const rename = useMutation((t: string) => codeApi.rename(session.id, t), {
    success: "Session renamed.",
  });
  const cacheAlert = useMutation(() => codeApi.cacheAlert(session.id, !session.cacheAlert), {
    errorToast: true,
  });
  const archive = useMutation(() => codeApi.archive(session.id), { success: "Session archived." });
  const unarchive = useMutation(() => codeApi.unarchive(session.id), {
    success: "Session unarchived.",
    errorToast: true,
  });

  const connected = ctx.link === "connected";
  const close = () => {
    setDialog(null);
    stop.reset();
    rename.reset();
    archive.reset();
  };

  const archiveBlocked = isBusy(session) ? "Stop the session before archiving it" : null;

  const dialogs = (
    <>
      <ConfirmDialog
        open={dialog === "stop"}
        onClose={close}
        title="Stop this session?"
        description="Stops the current execution and clears queued messages."
        confirmLabel="Stop session"
        busy={stop.busy}
        error={stop.error}
        errorTitle="Could not stop"
        onConfirm={() => void stop.run().then((ok) => ok && setDialog(null))}
      >
        <p className="text-sm text-muted">
          {run
            ? "The task keeps its run, marked interrupted and blocked (Stopped by user). Automation settings are unchanged."
            : "Pi stays available; you can send a new message afterwards."}
        </p>
      </ConfirmDialog>

      <Dialog
        open={dialog === "rename"}
        onClose={close}
        title="Rename session"
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="sy-rename-form"
              busy={rename.busy}
              disabled={!title.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          id="sy-rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            void rename.run(title.trim()).then((ok) => ok && setDialog(null));
          }}
          className="flex flex-col gap-2"
        >
          <Field id="sy-rename-input" label="Title">
            <TextInput
              id="sy-rename-input"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          {rename.error !== null && (
            <ErrorState compact title="Could not rename" error={errorMessage(rename.error)} />
          )}
        </form>
      </Dialog>

      <ConfirmDialog
        open={dialog === "archive"}
        onClose={close}
        title="Archive this session?"
        description="It leaves the navigator. The Pi session file stays on the host."
        danger={false}
        confirmLabel="Archive"
        busy={archive.busy}
        error={archive.error}
        errorTitle="Could not archive"
        onConfirm={() =>
          void archive.run().then((ok) => {
            if (!ok) return;
            setDialog(null);
            navigate("/code");
          })
        }
      >
        {session.runtime === "idle" && (
          <p className="text-sm text-muted">The idle Pi process is stopped first.</p>
        )}
      </ConfirmDialog>

      {ctx.workspace && (
        <LinkIssueDialog
          open={dialog === "link"}
          onClose={close}
          workspace={ctx.workspace}
          candidates={link.candidates}
        />
      )}

      <SessionInfoDialog
        session={session}
        hostLabel={`${ctx.hostName} (${ctx.link})`}
        open={dialog === "info"}
        onClose={close}
      />
    </>
  );

  return {
    canTakeover: control === "automation",
    canReturn: control === "human",
    canStop: isBusy(session) && connected,
    canResume: !isLive(session) && !!session.nativeHandle && !session.readOnly && connected,
    archiveBlocked,
    takeover: () => void takeover.run(),
    returnToAutomation: () => void ret.run(),
    requestStop: () => setDialog("stop"),
    resume: () => void resume.run(),
    openRename: () => {
      setTitle(session.title);
      setDialog("rename");
    },
    requestArchive: () => {
      if (archiveBlocked) toast.info(archiveBlocked);
      else setDialog("archive");
    },
    openInfo: () => setDialog("info"),
    toggleCacheAlert: () => void cacheAlert.run(),
    unarchive: () => void unarchive.run(),
    dismissAttention:
      inputAttention.length > 0
        ? () => {
            void Promise.all(inputAttention.map(dismissAttentionItem))
              .then(() => toast.success("Cleared. A question Pi is still waiting on stays."))
              .catch((e) => toast.error(errorMessage(e)));
          }
        : null,
    setPinned: (viewId, pinned) => {
      const path = `/api/views/${encodeURIComponent(viewId)}/sessions/${encodeURIComponent(session.id)}`;
      void (pinned ? apiPost(path) : apiDelete(path)).catch((e) => toast.error(errorMessage(e)));
    },
    isPrimary,
    setPrimary: (primary) => {
      void codeApi.setPrimary(session.id, primary).catch((e) => toast.error(errorMessage(e)));
    },
    newInBranch:
      session.projectId && session.workspaceId
        ? () => {
            void codeApi
              .createSession({
                projectId: session.projectId!,
                workspace: { existingId: session.workspaceId! },
                prompt: "",
              })
              .then((s) => {
                useSyncStore.getState().upsertSessionIfMissing(s);
                navigate(`/code/${encodeURIComponent(s.id)}`);
              })
              .catch((e) => toast.error(errorMessage(e)));
          }
        : null,
    issueLink:
      ctx.workspace && session.provenance !== "subagent"
        ? {
            ...link,
            open: () => setDialog("link"),
            unlink: () => {
              const i = link.linked;
              if (!i) return;
              void unlinkIssue(i.id)
                .then(() => toast.success(`Unlinked from #${i.number}`))
                .catch((e) => toast.error(errorMessage(e)));
            },
          }
        : null,
    busy: {
      takeover: takeover.busy,
      ret: ret.busy,
      stop: stop.busy,
      resume: resume.busy,
      unarchive: unarchive.busy,
    },
    dialogs,
  };
}

/** Resolve one attention item by hand and store the result. */
export async function dismissAttentionItem(item: AttentionItem): Promise<AttentionItem> {
  const res = await apiPost<AttentionItem>(`/api/attention/${encodeURIComponent(item.id)}/dismiss`);
  const next =
    res && typeof res === "object" && "id" in res
      ? res
      : { ...item, resolvedAt: new Date().toISOString() };
  useSyncStore.setState((st) =>
    st.attention[item.id] ? { attention: { ...st.attention, [item.id]: next } } : {},
  );
  return next;
}
