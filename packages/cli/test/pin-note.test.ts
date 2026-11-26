import type { Scope } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { pinNote } from "../src/mirror/binding.js";

const scope = (sessionIds: string[]) => ({ id: "viw_1", name: "work", sessionIds }) as Scope;
const api = (scopes: Scope[] | Error) => ({
  get: async <T>() => {
    if (scopes instanceof Error) throw scopes;
    return scopes as T;
  },
});

describe("pinNote", () => {
  it("says so when the new session was pinned", async () => {
    expect(await pinNote(api([scope(["ses_1"])]), { id: "viw_1" }, "ses_1")).toContain(
      'Pinned to scope "work"',
    );
  });

  it("says nothing when it was not pinned or scopes cannot be read", async () => {
    expect(await pinNote(api([scope([])]), { id: "viw_1" }, "ses_1")).toBeNull();
    expect(await pinNote(api(new Error("offline")), { id: "viw_1" }, "ses_1")).toBeNull();
  });
});
