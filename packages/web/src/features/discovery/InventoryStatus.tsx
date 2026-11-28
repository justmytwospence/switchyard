import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { errorMessage, isApiError } from "../../sync/api";
import type { IssueInventory } from "./useIssueInventory";

export function InventoryStatus({ inventory }: { inventory: IssueInventory }) {
  const { description, kind, loading, partial, error, lastSuccess, readerFailed, refresh } =
    inventory;
  return (
    <div className="space-y-1 text-xs text-muted">
      <p>{description.summary}</p>
      {description.sources.map((source) => (
        <div key={source.id}>
          <p>
            {source.name}: {source.description}
            {source.lastSyncedAt
              ? ` · Last successful sync ${source.lastSyncedAt}`
              : " · No successful sync yet"}
          </p>
          {source.lastError ? (
            <p role="status" className="text-warning">
              {source.lastSyncedAt
                ? "Showing last-known issues — source sync failed"
                : "Source sync failed"}
              : {source.lastError}
            </p>
          ) : source.paused ? (
            <p role="status" className="text-warning">
              Source sync paused. Issues are not being updated.
            </p>
          ) : null}
        </div>
      ))}
      {kind === "repository" && (
        <>
          {partial && <p role="status">Searching loaded issues · More issues may be available.</p>}
          {error != null && (
            <p role="status" className="text-warning">
              {lastSuccess
                ? readerFailed === "more"
                  ? "Showing loaded issues — loading more failed"
                  : "Showing cached issues — refresh failed"
                : "Repository issues unavailable"}
              : {errorMessage(error)}
              {isApiError(error, "unsupported_capability") &&
                " Update a checkout’s host agent to browse repository issues here."}
            </p>
          )}
          {lastSuccess && <p>Last successful read {lastSuccess}</p>}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {refresh && (
          <Button type="button" size="sm" disabled={loading} onClick={refresh}>
            Refresh
          </Button>
        )}
        {description.openIssuesUrl && (
          <a
            className="text-accent hover:underline"
            href={description.openIssuesUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View all open issues on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

export function InventoryEmpty({
  inventory,
  filtered,
  onNavigate,
}: {
  inventory: IssueInventory;
  filtered: boolean;
  onNavigate?: () => void;
}) {
  if (inventory.loading)
    return (
      <p role="status" className="text-sm text-muted">
        Loading issues…
      </p>
    );
  if (inventory.kind === "repository" && inventory.error != null) return null;
  const empty =
    inventory.kind === "repository" && inventory.partial
      ? {
          title: "No matches in loaded issues",
          description: "Load more issues to continue, or change the filters.",
        }
      : inventory.description.emptyState(
          filtered && (inventory.kind !== "repository" || inventory.allItems.length > 0),
        );
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{empty.title}</p>
      <p className="text-muted">{empty.description}</p>
      {empty.action && (
        <Link className="text-accent hover:underline" to={empty.action.to} onClick={onNavigate}>
          {empty.action.label}
        </Link>
      )}
    </div>
  );
}

export function InventoryMore({ inventory }: { inventory: IssueInventory }) {
  return (
    inventory.loadMore && (
      <Button type="button" size="sm" disabled={inventory.loading} onClick={inventory.loadMore}>
        {inventory.loading ? "Loading issues…" : "Load more"}
      </Button>
    )
  );
}
