import { GitHubIssueUrl, type TrackedIssue } from "@switchyard/protocol";
import type { ReactNode } from "react";
import { Markdown } from "../../components/intent/Markdown";
import { Button } from "../../components/ui/Button";
import { useResource } from "../../lib/useResource";
import { isApiError } from "../../sync/api";
import { cleanGitHubText } from "../code/githubLogic";
import { getIssueDescription } from "../workboard/api";

export interface IssuePreviewProps {
  issue: TrackedIssue;
  branchName?: string | null;
  sessionId?: string | null;
  children?: ReactNode;
}

/** Mounted only while inspecting an issue. Key the request and its state to that issue. */
export function IssuePreview(props: IssuePreviewProps) {
  return <IssueDetails key={props.issue.id} {...props} />;
}

function IssueDetails({ issue, branchName, sessionId, children }: IssuePreviewProps) {
  const { data, error, loading, reload } = useResource(issue.id, (signal) =>
    getIssueDescription(issue.id, signal),
  );
  const url = GitHubIssueUrl.safeParse(issue.url).data;
  const branch = branchName ?? issue.branch ?? issue.branches[0];
  return (
    <article aria-label={`Issue #${issue.number}`} className="min-w-0 space-y-4 break-words">
      <header className="space-y-1">
        <p className="text-xs text-muted">
          {issue.repository} · #{issue.number}
        </p>
        <h2 className="text-base font-semibold">{issue.title}</h2>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent hover:underline"
          >
            Open issue on GitHub
          </a>
        )}
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm [&_dt]:text-muted">
        <dt>Work</dt>
        <dd>
          {sessionId
            ? "Session exists"
            : branch
              ? "Linked branch"
              : issue.pullRequest?.state === "MERGED"
                ? "Merged"
                : "Not started"}
          {branch && ` · ${branch}`}
        </dd>
        {issue.board?.status && (
          <>
            <dt>Source status</dt>
            <dd>{issue.board.status}</dd>
          </>
        )}
        {issue.board?.priority && (
          <>
            <dt>Source priority</dt>
            <dd>{issue.board.priority.name}</dd>
          </>
        )}
        <dt>Assignees</dt>
        <dd>{issue.assignees.join(", ") || "Unassigned"}</dd>
        {issue.parent && (
          <>
            <dt>Part of</dt>
            <dd>
              <a
                href={issue.parent.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                #{issue.parent.number} {issue.parent.title}
              </a>
            </dd>
          </>
        )}
        {issue.subIssues && (
          <>
            <dt>Sub-issues</dt>
            <dd>
              {issue.subIssues.completed}/{issue.subIssues.total} complete
            </dd>
          </>
        )}
      </dl>
      {children}
      <section
        aria-label="Issue description"
        className="min-w-0 space-y-2 border-t border-border pt-3"
      >
        {loading ? (
          <p role="status" className="text-sm text-muted">
            Loading description…
          </p>
        ) : error ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted">
              Description unavailable.
              {isApiError(error, "unsupported_capability") &&
                " Update the source host to read it here."}
            </p>
            <Button type="button" size="sm" onClick={reload}>
              Retry description
            </Button>
          </div>
        ) : data?.body.trim() ? (
          <Markdown
            text={cleanGitHubText(data.body)}
            externalBaseUrl={url ?? "https://github.com/"}
          />
        ) : (
          <p className="text-sm text-muted">No description.</p>
        )}
        {data?.truncated && !loading && !error && (
          <p className="text-sm text-muted">
            Description shortened. Read the full issue on GitHub.
          </p>
        )}
      </section>
    </article>
  );
}
