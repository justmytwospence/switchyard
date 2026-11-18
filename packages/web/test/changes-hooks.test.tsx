// @vitest-environment happy-dom
import type { DiffResult, LogResult } from "@switchyard/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/features/code/api", () => ({
  codeApi: { diff: vi.fn(), commits: vi.fn() },
}));

import { codeApi } from "../src/features/code/api";
import {
  useChangesScope,
  useWorkspaceCommits,
  type WorkspaceDiff,
} from "../src/features/code/Changes";
import type { SessionContext } from "../src/features/code/hooks";
import { ApiClientError } from "../src/sync/api";

const diffApi = vi.mocked(codeApi.diff);
const commitsApi = vi.mocked(codeApi.commits);

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

const log = (...shas: string[]): LogResult => ({
  base: "main",
  scope: "branch",
  commits: shas.map((sha) => ({
    sha,
    subject: `commit ${sha.slice(0, 7)}`,
    author: "Ada",
    authoredAt: "2026-01-01T00:00:00.000Z",
    pushed: false,
  })),
  truncated: false,
  uncommitted: 0,
});

const diffResult = (patch: string | null = null): DiffResult => ({
  base: "main",
  files: [],
  patch,
});

const context = (workspaceId: string | null): SessionContext =>
  ({
    link: "connected",
    workspace: workspaceId ? { id: workspaceId, updatedAt: "2026-01-01T00:00:00.000Z" } : undefined,
  }) as unknown as SessionContext;

const allDiff = (fetchedAt: string | null = null): WorkspaceDiff => ({
  result: diffResult(),
  parsed: new Map(),
  loading: false,
  error: null,
  fetchedAt,
  outdated: false,
  refresh: vi.fn(),
  scope: "all",
});

beforeEach(() => {
  diffApi.mockReset();
  commitsApi.mockReset();
  diffApi.mockResolvedValue(diffResult());
});

describe("useWorkspaceCommits", () => {
  it("loads the commit log", async () => {
    commitsApi.mockResolvedValue(log(SHA));
    const { result } = renderHook(() => useWorkspaceCommits(context("w1"), null));
    await waitFor(() => expect(result.current.log).toEqual(log(SHA)));
    expect(result.current).toMatchObject({ unsupported: false, error: null });
  });

  it("marks an old host agent as unsupported without reporting an error", async () => {
    commitsApi.mockRejectedValue(new ApiClientError("unsupported_capability", "Too old", 501));
    const { result } = renderHook(() => useWorkspaceCommits(context("w1"), null));
    await waitFor(() => expect(result.current.unsupported).toBe(true));
    expect(result.current).toMatchObject({ log: null, error: null });
  });

  it("reports any other failure as an error", async () => {
    const failure = new ApiClientError("http", "Boom", 500);
    commitsApi.mockRejectedValue(failure);
    const { result } = renderHook(() => useWorkspaceCommits(context("w1"), null));
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.unsupported).toBe(false);
  });

  it("clears the log when the workspace changes", async () => {
    commitsApi.mockResolvedValueOnce(log(SHA));
    const { result, rerender } = renderHook(({ id }) => useWorkspaceCommits(context(id), null), {
      initialProps: { id: "w1" },
    });
    await waitFor(() => expect(result.current.log).not.toBeNull());
    commitsApi.mockReturnValueOnce(new Promise(() => {}));
    rerender({ id: "w2" });
    await waitFor(() => expect(result.current.log).toBeNull());
  });

  it("aborts the request in flight when the refresh key changes", async () => {
    let firstSignal: AbortSignal | undefined;
    // Like fetch: an aborted request rejects instead of resolving.
    commitsApi.mockImplementationOnce(
      (_id, signal) =>
        new Promise<LogResult>((_resolve, reject) => {
          firstSignal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    commitsApi.mockResolvedValueOnce(log(OTHER));
    const { result, rerender } = renderHook(({ key }) => useWorkspaceCommits(context("w1"), key), {
      initialProps: { key: "one" },
    });
    rerender({ key: "two" });
    await waitFor(() => expect(result.current.log).toEqual(log(OTHER)));
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useChangesScope", () => {
  it("starts on everything and shows the passed diff", async () => {
    commitsApi.mockResolvedValue(log(SHA));
    const diff = allDiff();
    const { result } = renderHook(() => useChangesScope(context("w1"), diff));
    await waitFor(() => expect(result.current.commits.log).not.toBeNull());
    expect(result.current.scope).toBe("all");
    expect(result.current.shown).toBe(diff);
  });

  it("fetches the diff of one commit when it is picked", async () => {
    commitsApi.mockResolvedValue(log(SHA));
    const { result } = renderHook(() => useChangesScope(context("w1"), allDiff()));
    await waitFor(() => expect(result.current.commits.log).not.toBeNull());
    act(() => result.current.setScope(SHA));
    await waitFor(() => expect(diffApi).toHaveBeenCalledTimes(1));
    expect(diffApi).toHaveBeenCalledWith("w1", undefined, expect.any(AbortSignal), SHA);
    expect(result.current.scope).toBe(SHA);
  });

  it("goes back to everything when the workspace changes", async () => {
    commitsApi.mockResolvedValue(log(SHA));
    const diff = allDiff();
    const { result, rerender } = renderHook(({ id }) => useChangesScope(context(id), diff), {
      initialProps: { id: "w1" },
    });
    await waitFor(() => expect(result.current.commits.log).not.toBeNull());
    act(() => result.current.setScope(SHA));
    expect(result.current.scope).toBe(SHA);
    rerender({ id: "w2" });
    await waitFor(() => expect(result.current.scope).toBe("all"));
  });

  it("goes back to everything when the picked commit leaves the log", async () => {
    commitsApi.mockResolvedValueOnce(log(SHA));
    const { result, rerender } = renderHook(
      ({ fetchedAt }) => useChangesScope(context("w1"), allDiff(fetchedAt)),
      { initialProps: { fetchedAt: "t1" as string | null } },
    );
    await waitFor(() => expect(result.current.commits.log).toEqual(log(SHA)));
    act(() => result.current.setScope(SHA));
    expect(result.current.scope).toBe(SHA);
    // A refetch (the diff's fetch time changed) no longer lists the commit.
    commitsApi.mockResolvedValueOnce(log(OTHER));
    rerender({ fetchedAt: "t2" });
    await waitFor(() => expect(result.current.scope).toBe("all"));
  });
});
