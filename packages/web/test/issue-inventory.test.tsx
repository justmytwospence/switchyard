// @vitest-environment happy-dom
import { Project, type RepoIssueItem, type Scope } from "@switchyard/protocol";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../src/app/auth";
import {
  InventoryEmpty,
  InventoryMore,
  InventoryStatus,
} from "../src/features/discovery/InventoryStatus";
import {
  loadedRepositoryIssues,
  useIssueInventory,
  useRepositoryIssueCache,
} from "../src/features/discovery/useIssueInventory";
import { useGlobalItems } from "../src/features/palette/useGlobalItems";
import { useSyncStore } from "../src/sync/store";

const now = "2026-11-02T10:00:00.000Z";
const alpha = project("alpha");
const beta = project("beta");
function project(id: string, repo = id) {
  return Project.parse({
    id,
    name: id,
    repoIdentity: `https://github.com/acme/${repo}`,
    defaultProfileId: null,
    defaultHostId: null,
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    createdAt: now,
    updatedAt: now,
  });
}
function issue(projectId: string, number: number): RepoIssueItem {
  const repository = `acme/${projectId}`;
  return {
    projectId,
    repository,
    number,
    itemId: `${projectId}-${number}`,
    title: `${projectId} issue ${number}`,
    url: `https://github.com/${repository}/issues/${number}`,
    assignees: [],
    branches: [],
    branch: null,
    workspaceId: null,
    sessionId: null,
    pullRequest: null,
    board: null,
  };
}
function source(
  id: string,
  lastSyncedAt: string | null,
  lastError: string | null = null,
  enabled = true,
): Scope {
  return {
    id,
    name: id,
    mode: "all",
    sessionIds: [],
    hostIds: null,
    projectIds: [alpha.id, beta.id],
    createdAt: now,
    updatedAt: now,
    source: {
      kind: "github",
      hostId: "source-host",
      owner: "acme",
      repositories: null,
      board: null,
      enabled,
      login: "me",
      lastSyncedAt,
      lastError,
      writeBack: false,
      moveShared: false,
    },
  };
}
function authenticate(id: string) {
  useAuth.setState({
    status: "authenticated",
    me: {
      admin: true,
      publicUrl: "https://switchyard.example",
      device: {
        id,
        name: id,
        kind: "browser",
        createdAt: now,
        lastSeenAt: null,
        revokedAt: null,
        push: { subscribed: false, permission: "unknown" },
      },
    },
  });
}
const defaults = {
  enabled: true,
  scope: null,
  projectId: null,
  query: "",
  subset: "all",
  sort: "number",
} satisfies Parameters<typeof useIssueInventory>[0];
const fetcher = vi.fn<typeof fetch>();
const page = (items: RepoIssueItem[], nextCursor: string | null = null) =>
  Response.json({ items, nextCursor });
const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((res) => {
      resolve = res;
    }),
    get resolve() {
      return resolve;
    },
  };
}

beforeEach(() => {
  authenticate("one");
  useRepositoryIssueCache.setState(null);
  useSyncStore.setState({
    projects: { alpha, beta },
    scopes: {},
    issues: {},
    sessions: {},
    workspaces: {},
  });
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  useAuth.setState({ status: "unauthenticated", me: null });
  useSyncStore.getState().reset();
  vi.unstubAllGlobals();
});

function InventoryView({ query }: { query: string }) {
  const inventory = useIssueInventory({ ...defaults, projectId: "alpha", query });
  return (
    <>
      <InventoryStatus inventory={inventory} />
      <output>{inventory.items.map((row) => row.issue.number).join(",")}</output>
      {!inventory.items.length && <InventoryEmpty inventory={inventory} filtered={!!query} />}
      <InventoryMore inventory={inventory} />
    </>
  );
}

describe("issue inventory reader", () => {
  it("does not fetch for overview, Columns, a closed launcher, source refinement, or pins", async () => {
    const board = source("board", now);
    const pins: Scope = { ...board, mode: "pinned", source: null };
    fetcher.mockResolvedValue(page([issue("alpha", 1)]));
    const { result, rerender } = renderHook(useIssueInventory, {
      initialProps: defaults as Parameters<typeof useIssueInventory>[0],
    });
    expect(result.current.coverage).toBe("known");
    expect(result.current.description.summary).toMatch(/Tracked work across repositories/);
    rerender({ ...defaults, projectId: "alpha", forceTracked: true });
    rerender({ ...defaults, projectId: "alpha", enabled: false });
    rerender({ ...defaults, projectId: "alpha", scope: board });
    expect(result.current.coverage).toBe("source");
    rerender({ ...defaults, projectId: "alpha", scope: pins });
    expect(result.current.kind).toBe("pins");
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ ...defaults, scope: board, entry: { kind: "repository", projectId: "alpha" } });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/projects/alpha/issues"]);
  });

  it("filters only loaded pages, keeps more reachable with zero matches, and replaces pages on refresh", async () => {
    fetcher
      .mockResolvedValueOnce(page([issue("alpha", 1)], "more"))
      .mockResolvedValueOnce(page([issue("alpha", 1), issue("alpha", 2)]))
      .mockResolvedValueOnce(page([issue("alpha", 3)]));
    const show = (query: string) => (
      <MemoryRouter>
        <InventoryView query={query} />
      </MemoryRouter>
    );
    const view = render(show("#2"));
    await screen.findByText(/Searching loaded issues/);
    expect(screen.getByText("No matches in loaded issues")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => screen.getByRole("button", { name: "Load more" }).click());
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("2");
    expect(screen.queryByText(/Searching loaded issues/)).toBeNull();
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/projects/alpha/issues?after=more");
    view.rerender(show(""));
    expect(screen.getByText("1,2")).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Refresh" }).click());
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("1,2")).toBeNull();
  });

  it("keeps cached evidence on an offline refresh and never follows a repeated cursor", async () => {
    fetcher
      .mockResolvedValueOnce(page([issue("alpha", 1)], "again"))
      .mockResolvedValueOnce(page([issue("alpha", 2)], "again"))
      .mockResolvedValueOnce(error(503, "host_unreachable", "The host is offline"));
    const { result } = renderHook(() => useIssueInventory({ ...defaults, projectId: "alpha" }));
    await waitFor(() => expect(result.current.lastSuccess).toBeTruthy());
    const loaded = result.current.lastSuccess;
    await act(async () => {
      result.current.loadMore?.();
      result.current.loadMore?.();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.loadMore).toBeNull();
    expect(result.current.partial).toBe(true);
    expect(result.current.readerFailed).toBe("more");
    expect(result.current.items.map((r) => r.issue.number)).toEqual([1]);
    await act(async () => result.current.refresh?.());
    expect(result.current.error).toMatchObject({ code: "host_unreachable" });
    expect(result.current.readerFailed).toBe("refresh");
    expect(result.current.lastSuccess).toBe(loaded);
    expect(result.current.items.map((r) => r.issue.number)).toEqual([1]);
    const view = render(
      <MemoryRouter>
        <InventoryStatus inventory={result.current} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Showing cached issues — refresh failed/)).toBeTruthy();
    view.unmount();
  });

  it("does not reuse old rows, cursors or in-flight results after a repo or device change", async () => {
    const lateRepo = deferred<Response>();
    const lateDevice = deferred<Response>();
    const lateRename = deferred<Response>();
    fetcher
      .mockResolvedValueOnce(page([issue("alpha", 1)], "alpha-more"))
      .mockImplementationOnce(() => lateRepo.promise)
      .mockResolvedValueOnce(page([issue("beta", 1)], "beta-more"))
      .mockImplementationOnce(() => lateDevice.promise)
      .mockResolvedValueOnce(page([issue("beta", 4)]))
      .mockImplementationOnce(() => lateRename.promise)
      .mockResolvedValueOnce(page([]));
    const { result, rerender } = renderHook(
      ({ id }) => useIssueInventory({ ...defaults, projectId: id }),
      { initialProps: { id: "alpha" } },
    );
    await waitFor(() => expect(result.current.items[0]?.projectId).toBe("alpha"));
    act(() => result.current.loadMore?.());
    const oldRepoSignal = fetcher.mock.calls[1]?.[1]?.signal;
    rerender({ id: "beta" });
    expect(result.current.items).toEqual([]);
    expect(result.current.loadMore).toBeNull();
    expect(oldRepoSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.items[0]?.projectId).toBe("beta"));
    await act(async () => lateRepo.resolve(page([issue("alpha", 2)])));
    expect(result.current.items.map((r) => r.projectId)).toEqual(["beta"]);
    act(() => result.current.loadMore?.());
    const oldDeviceSignal = fetcher.mock.calls[3]?.[1]?.signal;
    act(() => authenticate("two"));
    expect(result.current.items).toEqual([]);
    expect(oldDeviceSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.items[0]?.issue.number).toBe(4));
    await act(async () => lateDevice.resolve(page([issue("beta", 2)])));
    expect(result.current.items.map((r) => r.issue.number)).toEqual([4]);
    act(() => result.current.refresh?.());
    const oldRenameSignal = fetcher.mock.calls[5]?.[1]?.signal;
    act(() => useSyncStore.setState({ projects: { alpha, beta: project("beta", "renamed") } }));
    expect(result.current.items).toEqual([]);
    expect(oldRenameSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => lateRename.resolve(page([issue("beta", 5)])));
    expect(result.current.items).toEqual([]);
    expect(loadedRepositoryIssues(useRepositoryIssueCache.getState(), { alpha, beta })).toEqual([]);
  });

  it("makes an explicit project action and cached repo previews available in the palette without fetching", async () => {
    const row = issue("alpha", 17);
    fetcher.mockResolvedValue(page([row]));
    const palette = renderHook(() => ({ items: useGlobalItems(), location: useLocation() }), {
      wrapper: MemoryRouter,
    });
    expect(fetcher).not.toHaveBeenCalled();
    const browse = palette.result.current.items.find(
      (item) => item.title === "Browse repository issues in alpha",
    );
    expect(browse).toBeTruthy();
    act(() => browse?.run());
    expect(palette.result.current.location.state).toEqual({
      newSession: true,
      mode: "issue",
      projectId: "alpha",
      browseRepository: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    const { result } = renderHook(() => useIssueInventory({ ...defaults, projectId: "alpha" }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const preview = palette.result.current.items.find(
      (item) => item.title === "#17 alpha issue 17",
    );
    expect(preview).toBeTruthy();
    act(() => preview?.run());
    expect(palette.result.current.location.state).toEqual({
      newSession: true,
      mode: "issue",
      issue: { kind: "repository", projectId: "alpha", number: 17, nodeId: row.itemId },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows unsupported repository reads and stale source evidence, never a live empty list", async () => {
    fetcher.mockResolvedValue(error(422, "unsupported_capability", "Old reader"));
    const { result, rerender } = renderHook(useIssueInventory, {
      initialProps: { ...defaults, projectId: "alpha" } as Parameters<typeof useIssueInventory>[0],
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    const controls = () => (
      <MemoryRouter>
        <InventoryStatus inventory={result.current} />
        <InventoryEmpty inventory={result.current} filtered={false} />
      </MemoryRouter>
    );
    const view = render(controls());
    expect(screen.getByText(/Old reader.*Update a checkout/)).toBeTruthy();
    expect(screen.queryByText("No open issues")).toBeNull();
    const cached = source("cached board", now, "Upgrade its host agent");
    const unsynced = source("unsynced board", null, null, false);
    act(() => useSyncStore.setState({ scopes: { [cached.id]: cached, [unsynced.id]: unsynced } }));
    rerender(defaults);
    view.rerender(controls());
    expect(result.current.lastSuccess).toBe(now);
    expect(
      screen.getByText(/Showing last-known issues — source sync failed.*Upgrade its host agent/),
    ).toBeTruthy();
    expect(screen.getByText(/Source sync paused/)).toBeTruthy();
    expect(screen.getByText("No current issue results")).toBeTruthy();
    expect(screen.queryByText("No tracked issues here")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
