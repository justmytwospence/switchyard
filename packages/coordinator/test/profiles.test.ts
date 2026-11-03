import { afterEach, describe, expect, it } from "vitest";
import { seedDefaultProfiles } from "../src/routes/profiles.js";
import { resolveProfile } from "../src/sessions/service.js";
import { startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe("seeded profiles", () => {
  it("seeds Default then Vanilla, and never recreates a deleted Vanilla", async () => {
    t = await startCoordinator();
    const store = t.c.store;
    const list = store.profiles.list(undefined, [], "created_at, rowid");
    expect(list.map((p) => p.name)).toEqual(["Default", "Vanilla"]);
    expect(list[1]?.resources).toBe("vanilla");
    expect(resolveProfile(t.c as never, null, null).name).toBe("Default");
    store.profiles.delete(list[1]!.id);
    seedDefaultProfiles({ store });
    expect(store.profiles.list().map((p) => p.name)).toEqual(["Default"]);
  });
});
