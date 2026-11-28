import type { Project } from "@switchyard/protocol";
import { ChevronRight, FolderGit2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { buttonClasses } from "../../components/ui/Button";
import { EmptyState, LastKnownNote, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { matchesProject, repoLabel } from "../../lib/repo";
import { isActiveProject, useProjects, useSyncStore } from "../../sync/store";
import {
  CATALOG_CONNECT_PATH,
  CatalogConnections,
  useCatalogConnections,
} from "./CatalogConnections";
import { SectionPage, settingsPath, useHydrated } from "./shared";

export const projectPath = (id: string) => settingsPath(`projects/${encodeURIComponent(id)}`);

export function ProjectsSection() {
  const hydrated = useHydrated();
  const projects = useProjects(true);
  const catalog = useCatalogConnections();
  const [query, setQuery] = useState("");
  const active = projects.filter(isActiveProject);
  const previous = projects.filter((p) => !isActiveProject(p));
  const shown = active.filter((p) => matchesProject(p, query));
  const checkouts = useSyncStore((s) => s.checkouts);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of Object.values(checkouts)) out[c.projectId] = (out[c.projectId] ?? 0) + 1;
    return out;
  }, [checkouts]);
  const status = catalog.inventory;
  const hasConflicts = !!status?.conflicts.length;
  const hasCompleteList =
    !hasConflicts && status?.connections.some((c) => c.state === "ready" && c.lastSyncedAt);

  return (
    <SectionPage
      testId="settings-projects"
      title="Projects"
      description="Your Git provider determines which repositories are projects. Each project can have checkouts on several hosts or none at all."
      actions={
        status?.available && (
          <Link to={CATALOG_CONNECT_PATH} state={BACK_STATE} className={buttonClasses("primary")}>
            <Plus aria-hidden className="size-4" />
            Connect GitHub
          </Link>
        )
      }
    >
      <LastKnownNote />
      <CatalogConnections catalog={catalog} projects={projects} />
      {!hydrated ? (
        <LoadingState label="Loading projects…" />
      ) : active.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 className="size-8" />}
          title={hasCompleteList ? "No repositories selected" : "No active projects"}
          description={
            hasCompleteList
              ? "Manage repositories on GitHub to share more, then refresh the connection."
              : hasConflicts
                ? "Resolve the matching previous projects above to list those repositories."
                : "Repositories appear here after you connect an account and share repositories on GitHub."
          }
        />
      ) : (
        <>
          <div className="relative max-w-md">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
            />
            <TextInput
              type="search"
              aria-label="Search projects"
              placeholder="Search projects by name or remote"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState
              className="py-4"
              title="No matches"
              description={`No project matches "${query.trim()}".`}
              action={{ label: "Clear search", onClick: () => setQuery("") }}
            />
          ) : (
            <ProjectRows projects={shown} counts={counts} />
          )}
        </>
      )}
      {previous.length > 0 && (
        <details className="space-y-2 rounded-lg border border-border bg-surface p-3">
          <summary className="tap cursor-pointer text-sm font-medium">
            Previous projects — not connected ({previous.length})
          </summary>
          <p className="text-xs text-muted">
            Checkouts and session history are kept. These projects are not available for new work.
          </p>
          <ProjectRows projects={previous} counts={counts} />
        </details>
      )}
    </SectionPage>
  );
}

function ProjectRows({
  projects,
  counts,
}: {
  projects: Project[];
  counts: Record<string, number>;
}) {
  return (
    <ul className="overflow-hidden rounded-lg border border-border bg-surface">
      {projects.map((p) => {
        const count = counts[p.id] ?? 0;
        return (
          <li key={p.id} className="border-b border-border last:border-b-0">
            <Link
              to={projectPath(p.id)}
              state={BACK_STATE}
              className="tap flex min-w-0 items-center gap-3 px-4 py-2 hover:bg-surface-2"
            >
              <FolderGit2 aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{p.name}</span>
                <span className="truncate text-xs text-muted" title={p.repoIdentity}>
                  {p.catalog?.fullName ?? repoLabel(p.repoIdentity)}
                </span>
                <span className="flex flex-wrap gap-x-2 text-xs text-subtle">
                  {p.catalog?.fullName && (
                    <span>Repository account: {p.catalog.fullName.split("/")[0]}</span>
                  )}
                  <span>
                    {count} checkout{count === 1 ? "" : "s"}
                  </span>
                  {p.catalog?.state === "delisted" && <span>Removed from catalog</span>}
                  {p.catalog?.state === "legacy" && <span>Not connected</span>}
                </span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
