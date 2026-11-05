import type { FileEntry } from "@switchyard/protocol";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  WrapText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeView } from "../../components/intent/CodeView";
import { Markdown } from "../../components/intent/Markdown";
import { copyText } from "../../components/ui/Copy";
import { IconButton } from "../../components/ui/IconButton";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import {
  EmptyState,
  ErrorState,
  HostUnavailable,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import { langFor } from "../../lib/highlight";
import { isApiError } from "../../sync/api";
import { codeApi, type FileContent } from "./api";
import { STATUS_LABEL, type WorkspaceDiff } from "./Changes";
import type { SessionContext } from "./hooks";

type Listing = FileEntry[] | "loading" | { error: unknown };
type ChangeStatus = keyof typeof STATUS_LABEL;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

const BADGE: Record<ChangeStatus, { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-success" },
  untracked: { letter: "U", tone: "text-success" },
  modified: { letter: "M", tone: "text-warning" },
  renamed: { letter: "R", tone: "text-warning" },
  deleted: { letter: "D", tone: "text-danger" },
  binary: { letter: "B", tone: "text-muted" },
};

function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m?.[1] ?? "").toLowerCase();
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(name: string) {
  const ext = extOf(name);
  if (ext === "json" || ext === "jsonc") return FileJson;
  if (["md", "mdx", "markdown", "txt"].includes(ext)) return FileText;
  if (ext in IMAGE_MIME) return FileImage;
  if (langFor(name)) return FileCode;
  return File;
}

function relPath(e: FileEntry, ws: { path: string }, dir: string): string {
  if (e.path) return e.path.startsWith(`${ws.path}/`) ? e.path.slice(ws.path.length + 1) : e.path;
  return dir ? `${dir}/${e.name}` : e.name;
}

function StatusBadge({ status }: { status: ChangeStatus | undefined }) {
  if (!status) return null;
  const b = BADGE[status];
  return (
    <span
      title={STATUS_LABEL[status]}
      className={cn("shrink-0 font-mono text-[11px] font-semibold", b.tone)}
    >
      {b.letter}
    </span>
  );
}

/**
 * Workspace browser: a tree with change markers and a filter, and a preview with highlighted
 * source, rendered markdown and images. `openPath` (a file reference in the transcript) opens
 * that file directly.
 */
export function FilesTab({
  ctx,
  diff,
  openPath,
}: {
  ctx: SessionContext;
  diff: WorkspaceDiff;
  openPath?: { path: string; nonce: number } | null;
}) {
  const ws = ctx.workspace;
  const connected = ctx.link === "connected";
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const changed = useMemo(
    () => new Map<string, ChangeStatus>(diff.result?.files.map((f) => [f.path, f.status]) ?? []),
    [diff.result],
  );
  const changedDirs = useMemo(() => {
    const s = new Set<string>();
    for (const p of changed.keys()) for (const a of ancestors(p)) s.add(a);
    return s;
  }, [changed]);

  const wsId = ws?.id;
  const load = useCallback(
    (dir: string, force = false) => {
      if (!wsId) return;
      setListings((prev) => {
        const cur = prev.get(dir);
        if (cur && !force && (cur === "loading" || Array.isArray(cur))) return prev;
        return new Map(prev).set(dir, "loading");
      });
      codeApi.files(wsId, dir).then(
        (entries) => setListings((prev) => new Map(prev).set(dir, entries)),
        (error) => setListings((prev) => new Map(prev).set(dir, { error })),
      );
    },
    [wsId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on workspace or reconnect
  useEffect(() => {
    if (!wsId || !connected) return;
    setListings(new Map());
    load("", true);
    for (const d of expanded) load(d, true);
  }, [wsId, connected]);

  useEffect(() => {
    if (!openPath || !ws) return;
    const rel = openPath.path.startsWith(`${ws.path}/`)
      ? openPath.path.slice(ws.path.length + 1)
      : openPath.path.replace(/^\.\//, "");
    setFile(rel);
    const dirs = ancestors(rel);
    setExpanded((prev) => new Set([...prev, ...dirs]));
    for (const d of dirs) load(d);
  }, [openPath, ws, load]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        load(dir);
      }
      return next;
    });
  };

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

  if (file !== null) {
    return (
      <FilePreview ctx={ctx} file={file} status={changed.get(file)} onBack={() => setFile(null)} />
    );
  }

  // Visible rows of the tree.
  type Row = { entry: FileEntry; rel: string; depth: number };
  const rows: Row[] = [];
  const extra: { dir: string; depth: number; state: "loading" | { error: unknown } }[] = [];
  const walk = (dir: string, depth: number) => {
    const l = listings.get(dir);
    if (l === undefined || l === "loading") {
      if (dir !== "" || l === "loading") extra.push({ dir, depth, state: "loading" });
      return;
    }
    if (!Array.isArray(l)) {
      extra.push({ dir, depth, state: l });
      return;
    }
    for (const entry of l) {
      const rel = relPath(entry, ws, dir);
      rows.push({ entry, rel, depth });
      if (entry.kind === "dir" && expanded.has(rel)) walk(rel, depth + 1);
    }
  };
  walk("", 0);

  const q = filter.trim().toLowerCase();
  const matches: Row[] = [];
  if (q) {
    for (const [dir, l] of listings) {
      if (!Array.isArray(l)) continue;
      for (const entry of l) {
        const rel = relPath(entry, ws, dir);
        if (entry.kind !== "dir" && rel.toLowerCase().includes(q)) {
          matches.push({ entry, rel, depth: 0 });
        }
      }
    }
    matches.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const root = listings.get("");
  const visible = q ? matches.slice(0, 200) : rows;
  const tabbable = focused && visible.some((r) => r.rel === focused) ? focused : visible[0]?.rel;

  const move = (from: HTMLElement, delta: number) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])];
    items[items.indexOf(from) + delta]?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 px-2 py-2">
      <TextInput
        type="search"
        aria-label="Filter files"
        placeholder="Filter files"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full"
      />
      {root && !Array.isArray(root) && root !== "loading" ? (
        <ErrorState
          compact
          title="Could not list this folder"
          error={root.error}
          onRetry={() => load("", true)}
        />
      ) : root === undefined || root === "loading" ? (
        <LoadingState label="Loading folder…" />
      ) : q && matches.length === 0 ? (
        <EmptyState title="No matching files" className="py-6" />
      ) : !q && rows.length === 0 ? (
        <EmptyState title="Empty folder" className="py-6" />
      ) : (
        <div
          ref={listRef}
          role="tree"
          aria-label="Workspace files"
          className="flex min-w-0 flex-col"
        >
          {visible.map(({ entry: e, rel, depth }) => {
            const isDir = e.kind === "dir";
            const open = isDir && expanded.has(rel);
            const Icon = isDir
              ? open
                ? FolderOpen
                : Folder
              : e.kind === "symlink"
                ? Link2
                : iconFor(e.name);
            const status = changed.get(rel);
            return (
              <div key={rel} role="none" className="min-w-0">
                <button
                  type="button"
                  role="treeitem"
                  aria-selected={false}
                  aria-expanded={isDir ? open : undefined}
                  tabIndex={rel === tabbable ? 0 : -1}
                  onFocus={() => setFocused(rel)}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded pr-2 text-left text-[13px] hover:bg-surface-2"
                  onClick={() => (isDir ? toggle(rel) : setFile(rel))}
                  onKeyDown={(ev) => {
                    if (ev.key === "ArrowDown") {
                      ev.preventDefault();
                      move(ev.currentTarget, 1);
                    } else if (ev.key === "ArrowUp") {
                      ev.preventDefault();
                      move(ev.currentTarget, -1);
                    } else if (ev.key === "ArrowRight" && isDir && !open) {
                      ev.preventDefault();
                      toggle(rel);
                    } else if (ev.key === "ArrowLeft") {
                      ev.preventDefault();
                      if (isDir && open) toggle(rel);
                      else if (rel.includes("/")) {
                        const parent = parentDir(rel);
                        listRef.current
                          ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(parent)}"]`)
                          ?.focus();
                      }
                    }
                  }}
                  data-path={rel}
                >
                  {q ? null : isDir ? (
                    <ChevronRight
                      aria-hidden
                      className={cn(
                        "size-4 shrink-0 text-muted transition-transform",
                        open && "rotate-90",
                      )}
                    />
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className={cn("min-w-0 flex-1 truncate", q && "font-mono text-xs")}>
                    {q ? rel : e.name}
                    <span className="sr-only"> {isDir ? "folder" : "file"}</span>
                  </span>
                  {isDir && changedDirs.has(rel) && (
                    <span
                      title="Contains changes"
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                    />
                  )}
                  {!isDir && <StatusBadge status={status} />}
                  {!isDir && e.size !== null && (
                    <span className="shrink-0 text-xs text-subtle tabular-nums">
                      {formatSize(e.size)}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {!q &&
            extra.map((x) => (
              <div key={`x-${x.dir}`} role="none" style={{ paddingLeft: 8 + x.depth * 14 }}>
                {x.state === "loading" ? (
                  <span className="flex h-8 items-center text-xs text-muted">Loading…</span>
                ) : (
                  <ErrorState
                    compact
                    title="Could not list this folder"
                    error={x.state.error}
                    onRetry={() => load(x.dir, true)}
                  />
                )}
              </div>
            ))}
        </div>
      )}
      {q && <p className="text-xs text-muted">Searches folders you have opened.</p>}
    </div>
  );
}

function FilePreview({
  ctx,
  file,
  status,
  onBack,
}: {
  ctx: SessionContext;
  file: string;
  status: ChangeStatus | undefined;
  onBack: () => void;
}) {
  const ws = ctx.workspace!;
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [dims, setDims] = useState<string | null>(null);

  const name = file.split("/").pop() ?? file;
  const ext = extOf(file);
  const isMarkdown = ["md", "mdx", "markdown"].includes(ext);
  const isSvg = ext === "svg";
  const imageMime = IMAGE_MIME[ext];
  const Icon = iconFor(name);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce retries
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setContent(null);
    codeApi
      .file(ws.id, file, ac.signal)
      .then((c) => setContent(c))
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [ws.id, file, nonce]);

  const text = content && !content.binary ? content.text : null;
  const lines = text === null ? null : text.replace(/\n$/, "").split("\n").length;
  const dir = parentDir(file);
  const copy = (value: string) => {
    void copyText(value, "Copied");
  };
  const checkerboard =
    "flex justify-center bg-[conic-gradient(var(--sy-surface-2)_25%,var(--sy-surface)_0_50%,var(--sy-surface-2)_0_75%,var(--sy-surface)_0)] bg-[length:16px_16px] p-4";

  let body: React.ReactNode;
  if (loading) body = <LoadingState label="Loading file…" />;
  else if (error !== null) {
    body = isApiError(error, "too_large") ? (
      <EmptyState
        title="Too large to preview"
        description="Switchyard previews files up to 1 MB."
      />
    ) : (
      <ErrorState
        compact
        title="Could not read this file"
        error={error}
        onRetry={() => setNonce((n) => n + 1)}
      />
    );
  } else if (content && imageMime && content.base64) {
    body = (
      <div className={checkerboard}>
        <img
          alt={name}
          className="max-h-[60vh] max-w-full"
          src={`data:${imageMime};base64,${content.base64}`}
          onLoad={(e) =>
            setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)
          }
        />
      </div>
    );
  } else if (text !== null && isSvg && view === "preview") {
    body = (
      <div className={checkerboard}>
        <img
          alt={name}
          className="max-h-[60vh] max-w-full"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`}
        />
      </div>
    );
  } else if (text !== null && isMarkdown && view === "preview") {
    body = (
      <div className="px-4 py-2">
        <Markdown text={text} />
      </div>
    );
  } else if (text !== null) {
    body = <CodeView text={text} lang={langFor(file)} wrap={wrap} />;
  } else if (content) {
    body = (
      <EmptyState
        title="Binary file"
        description={`${content.size !== null ? formatSize(content.size) : "Unknown size"} — not shown`}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-col gap-1 border-b border-border px-3 pt-2 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton
            size="sm"
            label="Back to files"
            icon={<ArrowLeft className="size-4" />}
            onClick={onBack}
          />
          <Icon aria-hidden className="size-4 shrink-0 text-muted" />
          <h3 className="min-w-0 flex-1 truncate font-medium">{name}</h3>
          {status && (
            <span className={cn("shrink-0 text-xs font-medium", BADGE[status].tone)}>
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>
        <p className="min-w-0 truncate text-xs text-muted">
          <span className="font-mono">{dir || (ws.branch ?? "root")}</span>
          {content?.size != null && ` · ${formatSize(content.size)}`}
          {lines !== null && ` · ${lines} lines`}
          {dims && ` · ${dims}`}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {(isMarkdown || isSvg) && text !== null && (
            <SegmentedControl
              label="View"
              value={view}
              onChange={setView}
              options={[
                { value: "preview", label: "Preview" },
                { value: "source", label: "Source" },
              ]}
            />
          )}
          {text !== null && (
            <>
              <IconButton
                size="sm"
                label={wrap ? "Don't wrap lines" : "Wrap lines"}
                aria-pressed={wrap}
                icon={<WrapText className="size-4" />}
                onClick={() => setWrap((w) => !w)}
              />
              <IconButton
                size="sm"
                label="Copy contents"
                icon={<Copy className="size-4" />}
                onClick={() => copy(text)}
              />
            </>
          )}
          <IconButton
            size="sm"
            label="Copy path"
            icon={<Link2 className="size-4" />}
            onClick={() => copy(file)}
          />
        </div>
      </div>
      <div className="min-w-0 pb-3">{body}</div>
    </div>
  );
}
