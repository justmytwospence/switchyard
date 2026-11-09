import type { Workspace } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { mergeBlockReason } from "../src/features/code/githubLogic";
import type { SessionContext } from "../src/features/code/hooks";
import { PullRequest } from "../src/features/code/PullRequest";
import type { PullRequestState } from "../src/features/code/usePullRequest";
import { session } from "./fixtures";
import { NOW, snapshot } from "./github-fixtures";

function legacySnapshot() {
  const value = snapshot();
  value.pullRequest = { ...value.pullRequest! };
  Reflect.deleteProperty(value.pullRequest, "nodeId");
  return value;
}

describe("legacy PR identity", () => {
  it("requires a verified node ID for a new merge, but accepts a verified snapshot", () => {
    const legacy = legacySnapshot();
    expect(mergeBlockReason(legacy, NOW)).toContain("Refresh before merging");
    for (const nodeId of ["", "   "]) {
      const invalid = { ...legacy, pullRequest: { ...legacy.pullRequest!, nodeId } };
      expect(mergeBlockReason(invalid, NOW)).toContain("Refresh before merging");
    }
    const verified = { ...legacy, pullRequest: { ...legacy.pullRequest!, nodeId: "PR_node" } };
    expect(mergeBlockReason(verified, NOW)).toBeNull();
  });

  it("displays legacy PR details and refresh while disabling merge", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const ctx: SessionContext = {
        session: session("s"),
        workspace: { id: "w", branch: "topic", archivedAt: null } as Workspace,
        host: undefined,
        hostName: "host",
        link: "connected",
        project: undefined,
        run: null,
        task: undefined,
        control: "none",
        adapters: [],
      };
      const state: PullRequestState = {
        snapshot: legacySnapshot(),
        github: { available: true, reason: null },
        pageVisible: true,
        mergeUncertain: false,
        markMergeUncertain: vi.fn(),
        error: null,
        loading: false,
        refresh: vi.fn(),
        reload: vi.fn(),
      };
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <PullRequest ctx={ctx} state={state} active />
        </MemoryRouter>,
      );
      expect(html).toContain("A useful change");
      expect(html).toContain("Fix this edge case.");
      expect(html).toContain("Refresh before merging");
      expect(html).toContain(">Refresh</button>");
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Squash merge<\/button>/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
