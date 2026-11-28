import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogConnectionStatus, CatalogRepository, Project } from "@switchyard/protocol";
import type { RepositoryProvider } from "../../../coordinator/dist/index.js";
import { FakeRepositoryProvider } from "../../../test-fixtures/dist/index.js";
import type { Api } from "../support";

export const CATALOG_CONNECTIONS = "/api/catalog/connections";
export const CATALOG_CODE = "e2e-registration";

type CatalogStatus = { connections: CatalogConnectionStatus[] };

function inventoryPath(root: string, account: string): string {
  if (!/^[a-z0-9-]+$/.test(account)) throw new Error("Invalid e2e fixture account");
  return join(root, "catalog", `${account}.json`);
}

/** Each Playwright worker supplies an isolated inventory, so concurrent refreshes cannot coalesce. */
export function setCatalogInventory(
  root: string,
  account: string,
  inventory: CatalogRepository[] | null,
): void {
  const path = inventoryPath(root, account);
  mkdirSync(join(root, "catalog"), { recursive: true });
  // A provider refresh must only see complete writes. null simulates an unavailable inventory.
  writeFileSync(`${path}.tmp`, JSON.stringify(inventory));
  renameSync(`${path}.tmp`, path);
}

export function e2eRepositoryProvider(root: string): RepositoryProvider {
  const providers = new Map<string, FakeRepositoryProvider>();
  const registration = new FakeRepositoryProvider(() => []);
  const provider = (id: string) => {
    const fake = providers.get(id);
    if (!fake) throw new Error("No e2e inventory for this connection");
    return fake;
  };
  return {
    authority: registration.authority,
    beginRegistration: (input) => registration.beginRegistration(input),
    async completeRegistration({ connectionId, account, code }) {
      if (code !== CATALOG_CODE) throw new Error("Invalid e2e registration code");
      const path = inventoryPath(root, account);
      providers.set(
        connectionId,
        new FakeRepositoryProvider(() => {
          const inventory = JSON.parse(readFileSync(path, "utf8")) as CatalogRepository[] | null;
          if (!inventory) throw new Error("E2E inventory unavailable");
          return inventory;
        }),
      );
      return registration.completeRegistration();
    },
    listRepositories: async (id) => provider(id).listRepositories(),
    resolveRemote: async (id, remote) => provider(id).resolveRemote(id, remote),
    issueCloneGrant: () => registration.issueCloneGrant(),
    releaseGrant: () => registration.releaseGrant(),
    async disconnect(id) {
      providers.delete(id);
    },
  };
}

export async function catalogConnection(
  api: Api,
  account: string,
): Promise<CatalogConnectionStatus> {
  const { connections } = await api<CatalogStatus>("GET", CATALOG_CONNECTIONS);
  const connection = connections.find((c) => c.account === account);
  if (!connection) throw new Error(`Missing e2e catalog connection for ${account}`);
  return connection;
}

export async function registerFixtureCatalog(api: Api, account: string): Promise<string> {
  const { fields } = await api<{ fields: Record<string, string> }>(
    "POST",
    `${CATALOG_CONNECTIONS}/begin`,
    { account, accountType: "personal" },
  );
  await api("POST", `${CATALOG_CONNECTIONS}/complete`, { state: fields.state, code: CATALOG_CODE });
  return (await catalogConnection(api, account)).id;
}

export async function listedCatalogProject(api: Api, repo: CatalogRepository): Promise<Project> {
  const projects = await api<Project[]>("GET", "/api/projects");
  const project = projects.find(
    (p) =>
      p.catalog?.state === "listed" &&
      p.catalog.authority === repo.authority &&
      p.catalog.externalId === repo.externalId,
  );
  if (!project) throw new Error(`Missing listed e2e Project for ${repo.webUrl}`);
  return project;
}

export async function seedCatalogProject(
  api: Api,
  root: string,
  account: string,
  repo: CatalogRepository,
): Promise<Project> {
  setCatalogInventory(root, account, [repo]);
  const id = await registerFixtureCatalog(api, account);
  await api("POST", `${CATALOG_CONNECTIONS}/${id}/refresh`);
  return listedCatalogProject(api, repo);
}
