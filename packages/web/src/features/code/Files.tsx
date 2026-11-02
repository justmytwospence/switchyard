import type { FileEntry } from "@switchyard/protocol";
import { ArrowLeft, File, Folder, FolderOpen, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeBlock } from "../../components/intent/CodeBlock";
import { Button } from "../../components/ui/Button";
import {
  EmptyState,
  ErrorState,
  HostUnavailable,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { codeApi, type FileContent } from "./api";
import type { SessionContext } from "./hooks";

function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function extOf(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m?.[1];
}

/**
 * Read-only workspace browser (v1). `openPath` (from a file reference in the
 * transcript) opens that file directly.
 */
export function FilesTab({
  ctx,
  openPath,
}: {
  ctx: SessionContext;
  openPath?: { path: string; nonce: number } | null;
}) {
  const ws = ctx.workspace;
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const connected = ctx.link === "connected";

  useEffect(() => {
    if (!openPath || !ws) return;
    const rel = openPath.path.startsWith(`${ws.path}/`)
      ? openPath.path.slice(ws.path.length + 1)
      : openPath.path.replace(/^\.\//, "");
    setFile(rel);
    setDir(parentDir(rel));
  }, [openPath, ws]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce retries
  useEffect(() => {
    if (!ws || !connected) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    const p = file
      ? codeApi.file(ws.id, file, ac.signal).then((c) => setContent(c))
      : codeApi.files(ws.id, dir, ac.signal).then((e) => setEntries(e));
    p.catch((e) => {
      if (!ac.signal.aborted) setError(e);
    }).finally(() => {
      if (!ac.signal.aborted) setLoading(false);
    });
    return () => ac.abort();
  }, [ws?.id, connected, dir, file, nonce]);

  if (!ws) {
    return (
      <UnsupportedCapability
        capability="File browsing"
        reason={`This session is not linked to a Switchyard workspace (it runs in ${ctx.session.cwd}).`}
      />
    );
  }
  if (!connected) {
    return (
      <HostUnavailable
        compact
        hostName={ctx.hostName}
        connectivity={ctx.link === "reconnecting" ? "reconnecting" : "unreachable"}
        lastSeenAt={ctx.host?.lastSeenAt}
        detail="Files are read from the host; browsing resumes when it reconnects."
      />
    );
  }

  const crumbs = dir.split("/").filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          className="tap rounded px-1 font-mono text-accent hover:underline"
          onClick={() => {
            setFile(null);
            setDir("");
          }}
        >
          {ws.branch ?? "root"}
        </button>
        {crumbs.map((c, i) => {
          const path = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={path} className="flex items-center gap-1">
              <span aria-hidden className="text-subtle">
                /
              </span>
              <button
                type="button"
                className="tap rounded px-1 font-mono text-accent hover:underline"
                onClick={() => {
                  setFile(null);
                  setDir(path);
                }}
              >
                {c}
              </button>
            </span>
          );
        })}
        {file && (
          <span className="flex min-w-0 items-center gap-1">
            <span aria-hidden className="text-subtle">
              /
            </span>
            <span className="truncate font-mono">{file.split("/").pop()}</span>
          </span>
        )}
      </nav>
      <p className="text-xs text-muted">Read-only in this version.</p>

      {error !== null ? (
        <ErrorState
          compact
          title={file ? "Could not read this file" : "Could not list this folder"}
          error={error}
          onRetry={() => setNonce((n) => n + 1)}
        />
      ) : loading ? (
        <LoadingState label={file ? "Loading file…" : "Loading folder…"} />
      ) : file ? (
        <div className="flex min-w-0 flex-col gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            icon={<ArrowLeft className="size-3.5" />}
            onClick={() => setFile(null)}
          >
            Back to folder
          </Button>
          {!content ? null : content.binary || content.text === null ? (
            <p className="text-sm text-muted">Binary file not shown.</p>
          ) : (
            <>
              {content.truncated && (
                <p className="text-xs text-muted">Showing the beginning of a large file.</p>
              )}
              <CodeBlock text={content.text} lang={extOf(file)} maxHeight="70vh" />
            </>
          )}
        </div>
      ) : entries && entries.length === 0 ? (
        <EmptyState title="Empty folder" className="py-6" />
      ) : (
        <ul aria-label="Folder contents" className="flex min-w-0 flex-col">
          {dir && (
            <li>
              <button
                type="button"
                className="tap flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                onClick={() => setDir(parentDir(dir))}
              >
                <FolderOpen aria-hidden className="size-4 text-muted" />
                ..
              </button>
            </li>
          )}
          {(entries ?? []).map((e) => {
            const Icon = e.kind === "dir" ? Folder : e.kind === "symlink" ? Link2 : File;
            const rel = e.path
              ? e.path.startsWith(`${ws.path}/`)
                ? e.path.slice(ws.path.length + 1)
                : e.path
              : dir
                ? `${dir}/${e.name}`
                : e.name;
            return (
              <li key={rel} className="min-w-0">
                <button
                  type="button"
                  className="tap flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => (e.kind === "dir" ? setDir(rel) : setFile(rel))}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.name}</span>
                  <span className="sr-only">{e.kind === "dir" ? "folder" : "file"}</span>
                  {e.size !== null && e.kind === "file" && (
                    <span className="shrink-0 text-xs text-subtle tabular-nums">
                      {e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
