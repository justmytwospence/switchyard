import type { TranscriptItem } from "@switchyard/protocol";
import { MoreHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { TextArea } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { errorMessage } from "../../sync/api";
import { useHost, useSession } from "../../sync/store";
import { codeApi } from "./api";
import { applyPrefill, canNavigate, useOpenBranch } from "./branching";
import { isLive, piControlsAvailable } from "./model";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** Per-message actions: fork, rewind and re-answer. */
export function UserMessageMenu({ item, sessionId }: { item: UserItem; sessionId: string }) {
  const session = useSession(sessionId);
  const host = useHost(session?.hostId);
  const [dialog, setDialog] = useState<null | "rewind" | "reanswer">(null);
  const [summarize, setSummarize] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ids = useId();
  const openBranch = useOpenBranch(
    session ?? ({ projectId: null, workspaceId: null } as unknown as NonNullable<typeof session>),
  );
  const entryId = item.data.entryId;
  if (!session || !entryId) return null;

  const controls = piControlsAvailable(host, null);
  const fork = controls && !session.readOnly && isLive(session);
  const nav = canNavigate(session, host);
  const idle = session.runtime === "idle" && !session.compacting;
  const hint = idle ? undefined : "Wait for the reply to finish";

  const items: MenuItem[] = [];
  if (fork) {
    items.push({
      id: "fork",
      label: "Fork from here",
      onSelect: () => {
        void codeApi
          .branch(session.id, entryId, true)
          .then(openBranch)
          .catch((e) => toast.error(errorMessage(e)));
      },
    });
  }
  if (nav) {
    items.push({
      id: "rewind",
      label: "Rewind to here",
      disabled: !idle,
      hint,
      onSelect: () => {
        setError(null);
        setDialog("rewind");
      },
    });
    if (!item.data.images) {
      items.push({
        id: "reanswer",
        label: "Re-answer",
        disabled: !idle,
        hint,
        onSelect: () => {
          setError(null);
          setDialog("reanswer");
        },
      });
    }
  }
  if (items.length === 0) return null;

  const close = () => {
    setDialog(null);
    setBusy(false);
  };
  const rewind = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await codeApi.navigate(session.id, {
        entryId,
        summarize,
        instructions: summarize && instructions.trim() ? instructions.trim() : null,
      });
      close();
      toast.success(
        applyPrefill(session.id, r.prefill) === "kept"
          ? "Rewound. Your draft was kept."
          : "Rewound.",
      );
    } catch (e) {
      setBusy(false);
      toast.error(errorMessage(e));
    }
  };
  const reanswer = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await codeApi.navigate(session.id, {
        entryId,
        summarize: false,
        instructions: null,
      });
      await codeApi.prompt(session.id, { text: r.prefill ?? item.data.text, mode: "prompt" });
      close();
    } catch (e) {
      setBusy(false);
      setError(e);
    }
  };

  return (
    <>
      <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <Menu
          label="Message actions"
          items={items}
          trigger={(p) => (
            <IconButton
              {...p}
              size="sm"
              label="Message actions"
              icon={<MoreHorizontal className="size-4" />}
            />
          )}
        />
      </div>
      <Dialog
        open={dialog === "rewind"}
        onClose={busy ? () => undefined : close}
        title="Rewind to this message?"
        description="Later messages move to an abandoned branch you can still open with /tree. This message goes back into the composer."
        footer={
          <>
            {busy && summarize && (
              <Button onClick={() => void codeApi.abort(session.id, false).catch(() => {})}>
                Cancel summary
              </Button>
            )}
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void rewind()}>
              {busy && summarize ? "Summarizing…" : "Rewind"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {(
            [
              [false, "Just rewind"],
              [true, "Summarize the abandoned branch"],
            ] as const
          ).map(([v, label]) => (
            <div key={String(v)} className="flex items-center gap-2">
              <input
                id={`${ids}-${v}`}
                type="radio"
                name={`${ids}-summarize`}
                checked={summarize === v}
                disabled={busy}
                onChange={() => setSummarize(v)}
                className="tap size-5 shrink-0 accent-[var(--sy-accent)]"
              />
              <label htmlFor={`${ids}-${v}`} className="text-sm">
                {label}
              </label>
            </div>
          ))}
          {summarize && (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${ids}-instr`} className="text-sm font-medium">
                Summary instructions (optional)
              </label>
              <TextArea
                id={`${ids}-instr`}
                value={instructions}
                disabled={busy}
                maxLength={2000}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={dialog === "reanswer"}
        onClose={close}
        title="Re-answer this message?"
        description="Pi answers it again from here. The current reply moves to an abandoned branch you can still open with /tree."
        confirmLabel="Re-answer"
        danger={false}
        busy={busy}
        error={error}
        onConfirm={() => void reanswer()}
      />
    </>
  );
}
