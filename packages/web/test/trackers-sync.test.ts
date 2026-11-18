import type { Tracker } from "@switchyard/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sync/api", () => ({ apiGet: vi.fn() }));

import { apiGet } from "../src/sync/api";
import { useTrackersStore } from "../src/sync/trackers";

const get = vi.mocked(apiGet);
const tracker = (id: string, name = id) => ({ id, name }) as unknown as Tracker;

beforeEach(() => {
  get.mockReset();
  useTrackersStore.setState({ trackers: null, loading: false, error: null });
});

describe("trackers store", () => {
  it("joins concurrent loads into one request", async () => {
    let resolve!: (value: Tracker[]) => void;
    get.mockReturnValue(new Promise<Tracker[]>((r) => (resolve = r)));
    const first = useTrackersStore.getState().load();
    const second = useTrackersStore.getState().load();
    resolve([tracker("a")]);
    await Promise.all([first, second]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(useTrackersStore.getState().trackers).toEqual([tracker("a")]);
  });

  it("clears an earlier error when a load succeeds", async () => {
    useTrackersStore.setState({ error: new Error("old") });
    get.mockResolvedValue([tracker("a")]);
    await useTrackersStore.getState().load();
    expect(useTrackersStore.getState()).toMatchObject({
      trackers: [tracker("a")],
      error: null,
      loading: false,
    });
  });

  it("keeps the loaded trackers and records the error when a reload fails", async () => {
    useTrackersStore.setState({ trackers: [tracker("a")] });
    const failure = new Error("offline");
    get.mockRejectedValue(failure);
    await useTrackersStore.getState().load();
    expect(useTrackersStore.getState()).toMatchObject({
      trackers: [tracker("a")],
      error: failure,
      loading: false,
    });
  });

  it("upserts by id, appending new trackers", () => {
    useTrackersStore.setState({ trackers: [tracker("a", "one")] });
    useTrackersStore.getState().upsert(tracker("a", "renamed"));
    useTrackersStore.getState().upsert(tracker("b"));
    expect(useTrackersStore.getState().trackers).toEqual([tracker("a", "renamed"), tracker("b")]);
  });

  it("ignores upsert and remove until trackers are loaded", () => {
    useTrackersStore.getState().upsert(tracker("a"));
    useTrackersStore.getState().remove("a");
    expect(useTrackersStore.getState().trackers).toBeNull();
  });

  it("removes by id", () => {
    useTrackersStore.setState({ trackers: [tracker("a"), tracker("b")] });
    useTrackersStore.getState().remove("a");
    expect(useTrackersStore.getState().trackers).toEqual([tracker("b")]);
  });
});
