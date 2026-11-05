import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { errorMessage } from "../../sync/api";
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
  busy: { takeover: boolean; ret: boolean; stop: boolean; resume: boolean };
  /** Confirmation and form dialogs; render once in the view. */
  dialogs: ReactNode;
}

/** Session control and menu actions with confirmation dialogs (no optimistic success). */
export function useSessionActions(ctx: SessionContext): SessionActions {
  const { session, run, control } = ctx;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | "stop" | "rename" | "archive" | "info">(null);
  const [title, setTitle] = useState(session.title);

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
  const archive = useMutation(() => codeApi.archive(session.id), { success: "Session archived." });

  const connected = ctx.link === "connected";
  const close = () => {
    setDialog(null);
    stop.reset();
    rename.reset();
    archive.reset();
  };

  const archiveBlocked = session.archivedAt
    ? "Already archived"
    : isBusy(session)
      ? "Stop the session before archiving it"
      : null;

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
    busy: { takeover: takeover.busy, ret: ret.busy, stop: stop.busy, resume: resume.busy },
    dialogs,
  };
}
