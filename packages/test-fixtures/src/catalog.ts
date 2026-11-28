import type { CatalogRepository } from "@switchyard/protocol";

/** The catalog and Git's inspected origin use the same HTTPS identity. */
export function fixtureRepository(
  owner: string,
  name: string,
  authority = "github.com",
): CatalogRepository {
  const webUrl = `https://${authority}/${owner}/${name}`;
  return {
    authority,
    externalId: `${owner}/${name}`,
    owner,
    name,
    webUrl,
    cloneUrl: `${webUrl}.git`,
    defaultBranch: "main",
  };
}

/** An inventory-only fake: tests attach real or simulated checkouts, never clone over HTTPS. */
export class FakeRepositoryProvider {
  constructor(
    private readonly inventory: () => CatalogRepository[] | Promise<CatalogRepository[]>,
    readonly authority = "github.com",
  ) {}

  async beginRegistration({ state }: { state: string }) {
    return { url: `https://${this.authority}/registration`, fields: { state } };
  }

  async completeRegistration() {
    return { installUrl: `https://${this.authority}/install` };
  }

  async listRepositories() {
    return {
      state: "ready" as const,
      repositories: await this.inventory(),
      manageUrl: `https://${this.authority}/manage`,
    };
  }

  async resolveRemote(_connectionId: string, repoIdentity: string) {
    const repositories = await this.inventory();
    return (
      repositories.find((repo) => repo.webUrl.toLowerCase() === repoIdentity.toLowerCase())
        ?.externalId ?? null
    );
  }

  async issueCloneGrant(): Promise<never> {
    throw new Error("Fixture provider only supports existing checkouts");
  }

  async releaseGrant() {}
  async disconnect() {}
}

// Keep test-fixtures independent of the coordinator package (which consumes these fixtures).
interface FixtureCatalog {
  begin(
    device: string,
    account: string,
    accountType: "personal",
  ): Promise<{
    fields: Record<string, string>;
  }>;
  complete(device: string, state: string, code: string): Promise<void>;
  status(): { connections: { id: string; account: string; state: string }[] };
  refresh(id: string): Promise<void>;
}

/** Connect once via the catalog service, then sync the current fixture inventory. */
export async function connectFixtureCatalog(catalog: FixtureCatalog): Promise<string> {
  const device = "fixture-device";
  const account = "switchyard-fixture";
  const connection = () => catalog.status().connections.find((c) => c.account === account);
  if (!connection()) {
    const { fields } = await catalog.begin(device, account, "personal");
    if (!fields.state) throw new Error("Fixture provider did not return registration state");
    await catalog.complete(device, fields.state, "fixture-code");
  }
  const id = connection()?.id;
  if (!id) throw new Error("Fixture provider connection not found");
  await catalog.refresh(id);
  if (connection()?.state !== "ready") throw new Error("Fixture catalog did not become ready");
  return id;
}
