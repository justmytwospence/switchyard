import type { Task, TaskState } from "@switchyard/protocol";
import { CirclePause, Square } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { toast } from "../../components/ui/Toast";
import { errorMessage, isApiError } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import {
  fetchEligibility,
  moveTask,
  needsConfirmation,
  needsRunningChoice,
  taskAction,
  updateTask,
} from "./api";
import { eligibilityText, planMove, STATE_LABELS } from "./logic";

/**
 * Shared move/dispatch flow for drag-and-drop, "Move to…" menus, the mobile
 * Move sheet and drawer actions. Confirmations and the running-work choice
 * are dialogs; nothing is shown as done before the coordinator acknowledges.
 */

interface MoveOpts {
  position?: number;
}

interface Pending {
  kind: "choice" | "confirm_done" | "fresh_attempt";
  task: Task;
  to: TaskState;
  position?: number;
  reasons: string[];
  /** Flags already chosen in an earlier dialog (e.g. confirm, then the running choice). */
  carry?: { confirm?: boolean; onRunning?: "pause" | "stop" };
  /** Accept goes through POST /accept instead of /move. */
  via?: "accept";
}

export interface TaskMover {
  move(task: Task, to: TaskState, opts?: MoveOpts): Promise<void>;
  runNow(task: Task): Promise<void>;
  newAttempt(task: Task): Promise<void>;
  reorder(task: Task, position: number): Promise<void>;
  /** Accept a Review task (Done); asks for confirmation when criteria/checks are unresolved. */
  accept(task: Task): Promise<void>;
  isBusy(taskId: string): boolean;
}

const Ctx = createContext<TaskMover | null>(null);

export function useTaskMover(): TaskMover {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTaskMover must be used inside <MoveProvider>");
  return v;
}

const ACCEPT_NOTE = "Accepting marks the task Done. It does not merge or push.";

export function MoveProvider({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogBusy, setDialogBusy] = useState<"pause" | "stop" | "confirm" | null>(null);

  const withBusy = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => {
        const { [id]: _x, ...rest } = b;
        return rest;
      });
    }
  }, []);

  const afterMove = useCallback(async (task: Task, to: TaskState) => {
    if (to === "ready") {
      try {
        const e = await fetchEligibility(task.id);
        toast.success(`Moved to Ready. ${eligibilityText(e)}.`);
      } catch {
        toast.success("Moved to Ready. The dispatcher starts it when it is eligible.");
      }
      return;
    }
    toast.success(`Moved "${task.title}" to ${STATE_LABELS[to]}`);
  }, []);

  /** POST /move and route 409s to the right dialog. Returns false when a dialog took over. */
  const send = useCallback(
    async (
      task: Task,
      to: TaskState,
      extra: { confirm?: boolean; onRunning?: "pause" | "stop"; position?: number },
    ): Promise<boolean> => {
      try {
        await moveTask(task.id, { to, ...extra });
        await afterMove(task, to);
        return true;
      } catch (e) {
        if (!extra.onRunning && needsRunningChoice(e)) {
          setPending({
            kind: "choice",
            task,
            to,
            position: extra.position,
            reasons: [],
            carry: { confirm: extra.confirm },
          });
          return false;
        }
        if (!extra.confirm && needsConfirmation(e)) {
          setPending({
            kind: "confirm_done",
            task,
            to,
            position: extra.position,
            reasons: [errorMessage(e)],
            carry: { onRunning: extra.onRunning },
          });
          return false;
        }
        toast.error(`Could not move "${task.title}": ${errorMessage(e)}`);
        return false;
      }
    },
    [afterMove],
  );

  const runNow = useCallback(
    (task: Task) =>
      withBusy(task.id, async () => {
        try {
          await taskAction(task.id, "run-now");
          toast.info(`Dispatch requested for "${task.title}". Waiting for the host to confirm.`);
        } catch (e) {
          toast.error(`Cannot run "${task.title}" now: ${errorMessage(e)}`);
        }
      }),
    [withBusy],
  );

  const newAttempt = useCallback(
    (task: Task) =>
      withBusy(task.id, async () => {
        try {
          await taskAction(task.id, "new-attempt");
          toast.info(`New attempt requested for "${task.title}".`);
        } catch (e) {
          if (isApiError(e, "native_session_missing")) {
            setPending({
              kind: "fresh_attempt",
              task,
              to: "in_progress",
              reasons: [errorMessage(e)],
            });
            return;
          }
          toast.error(`Could not start a new attempt: ${errorMessage(e)}`);
        }
      }),
    [withBusy],
  );

  const move = useCallback(
    async (task: Task, to: TaskState, opts: MoveOpts = {}) => {
      const run = task.currentRunId ? useSyncStore.getState().runs[task.currentRunId] : undefined;
      const plan = planMove(task, to, run);
      switch (plan.kind) {
        case "noop":
          return;
        case "invalid":
          toast.error(plan.reason);
          return;
        case "run_now":
          return runNow(task);
        case "new_attempt":
          return newAttempt(task);
        case "choose_running":
          setPending({ kind: "choice", task, to, position: opts.position, reasons: [] });
          return;
        case "confirm_done":
          setPending({
            kind: "confirm_done",
            task,
            to,
            position: opts.position,
            reasons: plan.reasons,
          });
          return;
        case "move":
          await withBusy(task.id, async () => {
            await send(task, to, { position: opts.position });
          });
      }
    },
    [runNow, newAttempt, send, withBusy],
  );

  const reorder = useCallback(
    (task: Task, position: number) =>
      withBusy(task.id, async () => {
        try {
          await updateTask(task.id, { position });
        } catch (e) {
          toast.error(`Could not reorder: ${errorMessage(e)}`);
        }
      }),
    [withBusy],
  );

  const resolve = async (choice: "pause" | "stop" | "confirm") => {
    if (!pending) return;
    const p = pending;
    setDialogBusy(choice);
    try {
      if (p.kind === "fresh_attempt") {
        try {
          await taskAction(p.task.id, "new-attempt", {}, "?fresh=true");
          toast.info(`New attempt in a fresh session requested for "${p.task.title}".`);
        } catch (e) {
          toast.error(`Could not start a new attempt: ${errorMessage(e)}`);
        }
      } else if (p.via === "accept") {
        await withBusy(p.task.id, async () => {
          try {
            await taskAction(p.task.id, "accept", { confirm: true });
            toast.success(`Accepted "${p.task.title}". It is Done.`);
          } catch (e) {
            toast.error(`Could not accept: ${errorMessage(e)}`);
          }
        });
      } else {
        await withBusy(p.task.id, async () => {
          await send(p.task, p.to, {
            position: p.position,
            ...p.carry,
            ...(choice === "confirm" ? { confirm: true } : { onRunning: choice }),
          });
        });
      }
    } finally {
      setDialogBusy(null);
      setPending((cur) => (cur === p ? null : cur));
    }
  };

  const accept = useCallback(
    (task: Task) =>
      withBusy(task.id, async () => {
        try {
          await taskAction(task.id, "accept", {});
          toast.success(`Accepted "${task.title}". It is Done.`);
        } catch (e) {
          if (needsConfirmation(e)) {
            setPending({
              kind: "confirm_done",
              task,
              to: "done",
              reasons: [errorMessage(e)],
              via: "accept",
            });
            return;
          }
          toast.error(`Could not accept: ${errorMessage(e)}`);
        }
      }),
    [withBusy],
  );

  const value = useMemo<TaskMover>(
    () => ({ move, runNow, newAttempt, reorder, accept, isBusy: (id) => !!busy[id] }),
    [move, runNow, newAttempt, reorder, accept, busy],
  );

  const close = () => {
    if (!dialogBusy) setPending(null);
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <Dialog
        open={pending?.kind === "choice"}
        onClose={close}
        title="This task is running"
        description={
          pending
            ? `Moving "${pending.task.title}" to ${STATE_LABELS[pending.to]} needs a decision about its active run. Nothing changes until you choose.`
            : undefined
        }
        footer={
          <>
            <Button onClick={close} disabled={!!dialogBusy}>
              Keep running
            </Button>
            <Button
              icon={<CirclePause className="size-4" />}
              busy={dialogBusy === "pause"}
              disabled={!!dialogBusy}
              onClick={() => void resolve("pause")}
            >
              Pause automation
            </Button>
            <Button
              variant="danger"
              icon={<Square className="size-4" />}
              busy={dialogBusy === "stop"}
              disabled={!!dialogBusy}
              onClick={() => void resolve("stop")}
            >
              Stop execution
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            <span className="font-medium">Pause automation</span>: you take over the session. The
            agent keeps its current turn, and automatic continuations, retries and successor runs
            stop until you return it to automation.
          </li>
          <li>
            <span className="font-medium">Stop execution</span>: aborts the current run. The session
            and its workspace are kept.
          </li>
        </ul>
      </Dialog>
      <ConfirmDialog
        open={pending?.kind === "confirm_done"}
        onClose={close}
        title="Accept and mark Done?"
        description={ACCEPT_NOTE}
        danger={false}
        confirmLabel="Accept and mark Done"
        busy={dialogBusy === "confirm"}
        onConfirm={() => void resolve("confirm")}
      >
        <p className="mb-2 text-sm">These items are unresolved:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {pending?.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {pending && pending.task.acceptanceCriteria.length > 0 && (
          <>
            <p className="mt-3 mb-1 text-sm font-medium">Acceptance criteria</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {pending.task.acceptanceCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === "fresh_attempt"}
        onClose={close}
        title="Start a fresh session?"
        description={pending?.reasons[0]}
        danger={false}
        confirmLabel="Start fresh session"
        busy={dialogBusy === "confirm"}
        onConfirm={() => void resolve("confirm")}
      >
        <p className="text-sm">
          The previous Pi session is no longer available on the host, so the new attempt cannot
          continue it. A fresh session starts with the task objective and your review feedback.
        </p>
      </ConfirmDialog>
    </Ctx.Provider>
  );
}
