import type { View } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { pinNote } from "../src/mirror/binding.js";

const view = (sessionIds: string[]) => ({ id: "viw_1", name: "work", sessionIds }) as View;
const api = (views: View[] | Error) => ({
  get: async <T>() => {
    if (views instanceof Error) throw views;
    return views as T;
  },
});

describe("pinNote", () => {
  it("says so when the new session was pinned", async () => {
    expect(await pinNote(api([view(["ses_1"])]), { id: "viw_1" }, "ses_1")).toContain(
      'Pinned to view "work"',
    );
  });

  it("says nothing when it was not pinned or views cannot be read", async () => {
    expect(await pinNote(api([view([])]), { id: "viw_1" }, "ses_1")).toBeNull();
    expect(await pinNote(api(new Error("offline")), { id: "viw_1" }, "ses_1")).toBeNull();
  });
});
