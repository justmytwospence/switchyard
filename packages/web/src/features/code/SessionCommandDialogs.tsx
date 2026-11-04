import type { ImportableSession, Session, TreeRow } from "@switchyard/protocol";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { ErrorState } from "../../components/ui/states";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { codeApi } from "./api";

function Surface({
  mobile,
  ...props
}: {
  mobile: boolean;
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return mobile ? <Sheet {...props} /> : <Dialog {...props} />;
}

export interface TreeDialogProps {
  session: Session;
  mode: "tree" | "fork";
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onPick: (entryId: string) => void;
}

/** Pick a point in the conversation to start a new session from. */
export function TreeDialog({ session, mode, open, mobile, onClose, onPick }: TreeDialogProps) {
  const [rows, setRows] = useState<TreeRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    let live = true;
    codeApi.tree(session.id).then(
      (r) => live && setRows(r.rows),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [open, session.id]);
  const shown =
    rows === null
      ? []
      : mode === "fork"
        ? rows.filter((r) => r.role === "user" && r.activeBranch).reverse()
        : rows;
  return (
    <Surface
      mobile={mobile}
      open={open}
      onClose={onClose}
      title={mode === "fork" ? "Fork from a message" : "Start a new session from…"}
    >
      {error !== null ? (
        <ErrorState compact title="Could not load the conversation" error={errorMessage(error)} />
      ) : rows === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">Nothing to branch from yet</p>
      ) : (
        <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
          {shown.map((r) => (
            <li key={r.entryId} style={{ paddingLeft: `${Math.min(r.depth, 8) * 12}px` }}>
              <button
                type="button"
                onClick={() => onPick(r.entryId)}
                className={cn(
                  "flex w-full min-w-0 items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-sm hover:bg-surface-2",
                  r.activeBranch ? "border-accent" : "border-transparent",
                )}
              >
                <span className="w-8 shrink-0 text-xs text-muted">
                  {r.role === "user" ? "You" : "Pi"}
                </span>
                <span className="min-w-0 flex-1 truncate">{r.text || "(empty)"}</span>
                {r.label && <Badge>{r.label}</Badge>}
                {r.leaf && <Badge>current</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

export interface ResumeDialogProps {
  session: Session;
  open: boolean;
  mobile: boolean;
  onClose: () => void;
  onOpen: (sessionId: string) => void;
}

type Row = ImportableSession & { importedSessionId: string | null };

/** Open another Pi session from this folder, importing it when needed. */
export function ResumeDialog({ session, open, mobile, onClose, onOpen }: ResumeDialogProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    let live = true;
    codeApi.importable(session.hostId).then(
      (r) => live && setRows(r),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [open, session.hostId]);
  const list = (rows ?? [])
    .filter((r) => r.cwd === session.cwd && r.sessionFile !== session.nativeHandle?.sessionFile)
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  const choose = async (r: Row) => {
    try {
      if (r.importedSessionId) {
        onOpen(r.importedSessionId);
        return;
      }
      setBusy(true);
      const s = await codeApi.importSession(session.hostId, r.sessionFile, session.projectId);
      useSyncStore.getState().upsertSessionIfMissing(s);
      onOpen(s.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Surface mobile={mobile} open={open} onClose={onClose} title="Open another Pi session">
      {error !== null ? (
        <ErrorState compact title="Could not open it" error={errorMessage(error)} />
      ) : rows === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">No other Pi sessions in this folder</p>
      ) : (
        <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
          {list.map((r) => {
            const usable = r.importedSessionId !== null || r.inactive;
            return (
              <li key={r.sessionFile}>
                <button
                  type="button"
                  disabled={!usable || busy}
                  onClick={() => void choose(r)}
                  className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-60"
                >
                  <span className="truncate">{r.name ?? r.sessionId}</span>
                  <span className="text-xs text-muted">
                    {formatRelative(r.mtime)}
                    {!usable && " · Open in Pi; close it there to import"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Surface>
  );
}
