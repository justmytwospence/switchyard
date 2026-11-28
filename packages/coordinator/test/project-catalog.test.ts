// @module-tag slow
import type { CatalogRepository } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryProvider } from "../src/index.js";
import { getService } from "../src/services.js";
import { startCoordinator, type TestCoordinator } from "./helpers.js";

function repo(id: string, name: string): CatalogRepository {
  return {
    authority: "github.com",
    externalId: id,
    owner: "acme",
    name,
    webUrl: `https://github.com/acme/${name}`,
    cloneUrl: `https://github.com/acme/${name}.git`,
    defaultBranch: "main",
  };
}

let t: TestCoordinator | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe("project catalog", () => {
  async function setup() {
    const inventories = new Map<string, CatalogRepository[] | Error>();
    const provider: RepositoryProvider = {
      authority: "github.com",
      async beginRegistration({ state, connectionId }) {
        return { url: "https://github.com/settings/apps/new", fields: { state, connectionId } };
      },
      async completeRegistration() {
        return { installUrl: "https://github.com/apps/test/installations/new" };
      },
      async listRepositories(id) {
        const value = inventories.get(id);
        if (value instanceof Error) throw value;
        return value
          ? {
              state: "ready",
              repositories: value,
              manageUrl: "https://github.com/settings/installations/1",
            }
          : { state: "pending" };
      },
      async resolveRemote() {
        return null;
      },
      async issueCloneGrant() {
        throw new Error("not used");
      },
      async releaseGrant() {},
      async disconnect() {},
    };
    t = await startCoordinator({ repositoryProvider: provider });
    const catalog = getService(t.c.ctx, "catalog")!;
    const connect = async (account: string) => {
      const start = await catalog.begin("device", account, "personal");
      await catalog.complete("device", start.fields.state!, "code");
      return start.fields.connectionId!;
    };
    return { t, catalog, connect, inventories };
  }

  it("lists repositories with no hosts, preserves IDs and settings across rename, and does not reuse old slugs as IDs", async () => {
    const { t, catalog, connect, inventories } = await setup();
    const id = await connect("acme");
    inventories.set(id, [repo("1", "one")]);
    await catalog.refresh(id);
    const original = t.c.store.projects.list()[0]!;
    expect(original.catalog?.state).toBe("listed");
    expect(t.c.store.checkouts.list()).toEqual([]);
    t.c.store.putProject({ ...original, name: "Local name" });
    inventories.set(id, [repo("1", "renamed"), repo("2", "one")]);
    await catalog.refresh(id);
    expect(t.c.store.projects.require(original.id)).toMatchObject({
      name: "Local name",
      repoIdentity: "https://github.com/acme/renamed",
    });
    expect(t.c.store.projects.list().find((p) => p.catalog?.externalId === "2")?.id).not.toBe(
      original.id,
    );
  });

  it("keeps last-known membership on error, confirms absence twice, unions connections and reactivates the original ID", async () => {
    const { t, catalog, connect, inventories } = await setup();
    const a = await connect("one"),
      b = await connect("two");
    inventories.set(a, [repo("1", "one")]);
    inventories.set(b, [repo("1", "one")]);
    await catalog.refresh(a);
    await catalog.refresh(b);
    const p = t.c.store.projects.list()[0]!;
    await catalog.disconnect(b);
    inventories.set(a, []);
    await catalog.refresh(a);
    expect(t.c.store.projects.require(p.id).catalog?.state).toBe("listed");
    inventories.set(a, new Error("secret"));
    await catalog.refresh(a);
    expect(catalog.status().connections[0]).toMatchObject({ state: "stale" });
    expect(JSON.stringify(catalog.status())).not.toContain("secret");
    expect(t.c.store.projects.require(p.id).catalog?.state).toBe("listed");
    inventories.set(a, []);
    await catalog.refresh(a);
    expect(t.c.store.projects.require(p.id).catalog?.state).toBe("delisted");
    inventories.set(a, [repo("1", "one")]);
    await catalog.refresh(a);
    expect(t.c.store.projects.list()).toHaveLength(1);
    expect(t.c.store.projects.require(p.id).catalog?.state).toBe("listed");
  });

  it("does not silently choose between two legacy rows and adopts the chosen history in place", async () => {
    const { t, catalog, connect, inventories } = await setup();
    const id = await connect("acme");
    const stamp = t.c.store.nowIso();
    for (const n of ["prj_a", "prj_b"]) {
      t.c.store.putProject({
        id: n,
        name: n,
        repoIdentity: "https://github.com/ACME/ONE",
        catalog: { state: "legacy" },
        defaultProfileId: null,
        defaultHostId: null,
        maxConcurrentRuns: 7,
        automationEnabled: false,
        setupCommand: null,
        checks: [],
        workspaceSharing: "single_writer",
        worktreeDir: ".worktrees",
        ensureSessions: false,
        removeLanded: false,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    inventories.set(id, [repo("1", "one")]);
    await catalog.refresh(id);
    expect(catalog.status().conflicts[0]?.projectIds).toEqual(["prj_a", "prj_b"]);
    expect(() => catalog.resolveHistory(id, "1", "prj_wrong")).toThrow(/does not match/);
    catalog.resolveHistory(id, "1", "prj_b");
    expect(t.c.store.projects.require("prj_b")).toMatchObject({
      catalog: { state: "listed", externalId: "1" },
      maxConcurrentRuns: 7,
    });
    expect(t.c.store.projects.require("prj_a").catalog?.state).toBe("legacy");
    inventories.set(id, [repo("1", "one"), repo("1", "duplicate")]);
    await catalog.refresh(id);
    expect(catalog.status().connections[0]?.state).toBe("stale");
    expect(t.c.store.projects.list()).toHaveLength(2);
  });

  it("binds registration to the initiating device, expiry, and a single use", async () => {
    const { t, catalog } = await setup();
    const { fields } = await catalog.begin("first", "acme", "personal");
    await expect(catalog.complete("second", fields.state!, "code")).rejects.toMatchObject({
      code: "forbidden",
    });
    await catalog.complete("first", fields.state!, "code");
    await expect(catalog.complete("first", fields.state!, "code")).rejects.toMatchObject({
      code: "forbidden",
    });
    const expired = await catalog.begin("first", "acme", "personal");
    t.clock.advance(600_001);
    await expect(catalog.complete("first", expired.fields.state!, "code")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      (
        await t.api("POST", "/api/catalog/connections/begin", {
          body: { account: "acme", accountType: "personal" },
        })
      ).status,
    ).toBe(401);
  });
});
