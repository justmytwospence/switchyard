import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryProvider } from "@switchyard/coordinator";
import type { CatalogRepository } from "@switchyard/protocol";

export type AccountType = "personal" | "organization";
type Credentials = {
  appId: number;
  pem: string;
  accountId: number;
  account: string;
  accountType: AccountType;
  slug: string;
  installationId?: number;
};
type Registration = {
  connectionId: string;
  account: string;
  accountType: AccountType;
  returnUrl: string;
  state: string;
};

/** GitHub credentials and all GitHub traffic stay in the catalog worker. */
export class GitHubApp implements RepositoryProvider {
  readonly authority = "github.com";
  constructor(
    private dataDir: string,
    private request: typeof fetch = fetch,
  ) {}

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid connection ID");
    return join(this.dataDir, "catalog-secrets", id);
  }
  private async api(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") throw new Error("Invalid GitHub API URL");
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw new Error("GitHub API unavailable");
    }
    if (!response.ok) {
      const retry =
        response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub API failed (${response.status})${retry && /^\d{1,12}$/.test(retry) ? `; retry: ${retry}` : ""}`,
      );
    }
    return response;
  }
  private async credentials(id: string): Promise<Credentials> {
    try {
      const value = JSON.parse(
        await readFile(join(this.path(id), "app.json"), "utf8"),
      ) as Credentials;
      if (
        !Number.isSafeInteger(value.appId) ||
        !Number.isSafeInteger(value.accountId) ||
        typeof value.pem !== "string" ||
        typeof value.slug !== "string" ||
        typeof value.account !== "string" ||
        !["personal", "organization"].includes(value.accountType)
      )
        throw new Error();
      if (createPrivateKey(value.pem).asymmetricKeyType !== "rsa") throw new Error();
      return value;
    } catch {
      throw new Error("Reconnect provider: GitHub App credentials are missing or invalid");
    }
  }
  private jwt(c: Credentials): string {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: c.appId })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(payload);
    signer.end();
    return `${payload}.${signer.sign(c.pem, "base64url")}`;
  }
  async beginRegistration(
    input: Registration,
  ): Promise<{ url: string; fields: Record<string, string> }> {
    this.path(input.connectionId);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.account))
      throw new Error("Invalid GitHub account");
    const url =
      input.accountType === "organization"
        ? `https://github.com/organizations/${encodeURIComponent(input.account)}/settings/apps/new`
        : "https://github.com/settings/apps/new";
    const manifest = {
      name: `Switchyard ${input.account} ${randomUUID().slice(0, 8)}`,
      url: input.returnUrl,
      redirect_url: input.returnUrl,
      public: false,
      default_permissions: { contents: "read" },
      default_events: [],
      hook_attributes: { active: false },
    };
    return {
      url: `${url}?state=${encodeURIComponent(input.state)}`,
      fields: { manifest: JSON.stringify(manifest) },
    };
  }
  async completeRegistration(
    input: Omit<Registration, "returnUrl" | "state"> & { code: string },
  ): Promise<{ installUrl: string }> {
    const dir = this.path(input.connectionId);
    const response = await this.api(
      `/app-manifests/${encodeURIComponent(input.code)}/conversions`,
      undefined,
      { method: "POST" },
    );
    const app = (await response.json()) as any;
    const expectedType = input.accountType === "personal" ? "User" : "Organization";
    if (
      !Number.isSafeInteger(app.id) ||
      typeof app.pem !== "string" ||
      typeof app.slug !== "string" ||
      !Number.isSafeInteger(app.owner?.id) ||
      app.owner?.type !== expectedType ||
      typeof app.owner?.login !== "string" ||
      app.owner.login.toLowerCase() !== input.account.toLowerCase()
    )
      throw new Error("GitHub App owner does not match the requested account");
    try {
      if (createPrivateKey(app.pem).asymmetricKeyType !== "rsa") throw new Error();
    } catch {
      throw new Error("Invalid GitHub App key");
    }
    const creds: Credentials = {
      appId: app.id,
      pem: app.pem,
      accountId: app.owner.id,
      account: app.owner.login,
      accountType: input.accountType,
      slug: app.slug,
    };
    await this.saveCredentials(dir, creds);
    return {
      installUrl: `https://github.com/apps/${encodeURIComponent(creds.slug)}/installations/new`,
    };
  }
  private async saveCredentials(dir: string, creds: Credentials): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const temp = join(dir, `.app-${randomUUID()}`);
    try {
      await writeFile(temp, JSON.stringify(creds), { mode: 0o600, flag: "wx" });
      await rename(temp, join(dir, "app.json"));
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async installations(c: Credentials): Promise<any[]> {
    const all: any[] = [];
    const visited = new Set<string>();
    let next: string | null = "/app/installations?per_page=100";
    while (next) {
      const url = new URL(next, "https://api.github.com").href;
      if (visited.has(url) || visited.size >= 1001) throw new Error("Invalid GitHub pagination");
      visited.add(url);
      const r: Response = await this.api(next, this.jwt(c));
      const page: unknown = await r.json();
      if (
        !Array.isArray(page) ||
        page.some(
          (item) =>
            !Number.isSafeInteger(item?.id) ||
            !Number.isSafeInteger(item?.app_id) ||
            !Number.isSafeInteger(item?.account?.id) ||
            !["User", "Organization"].includes(item?.account?.type),
        )
      )
        throw new Error("Invalid installation inventory");
      all.push(...page);
      if (all.length > 100000) throw new Error("GitHub installation inventory too large");
      next = this.next(r);
    }
    return all;
  }
  private next(r: Response): string | null {
    const link = r.headers.get("link");
    if (!link) return null;
    const entry = link.split(",").find((v) => /rel="next"/.test(v));
    if (!entry) return null;
    const match = entry.match(/<([^>]+)>/);
    if (!match) throw new Error("Invalid GitHub pagination");
    const url = new URL(match[1]);
    if (url.origin !== "https://api.github.com")
      throw new Error("Invalid GitHub pagination origin");
    return url.href;
  }
  private async installation(
    id: string,
  ): Promise<{ credentials: Credentials; installation: any | null; manageUrl: string }> {
    const credentials = await this.credentials(id);
    const matching = (await this.installations(credentials)).filter(
      (i) =>
        i.app_id === credentials.appId &&
        i.account?.id === credentials.accountId &&
        i.account?.type === (credentials.accountType === "personal" ? "User" : "Organization"),
    );
    if (matching.length > 1) throw new Error("Ambiguous GitHub installation");
    if (matching[0] && credentials.installationId !== matching[0].id) {
      credentials.installationId = matching[0].id;
      await this.saveCredentials(this.path(id), credentials);
    }
    return {
      credentials,
      installation: matching[0] ?? null,
      manageUrl: `https://github.com/apps/${encodeURIComponent(credentials.slug)}/installations/new`,
    };
  }
  async installationStatus(
    id: string,
  ): Promise<{ state: "ready" | "pending" | "suspended" | "removed"; manageUrl: string }> {
    const { credentials, installation, manageUrl } = await this.installation(id);
    return {
      state: !installation
        ? credentials.installationId
          ? "removed"
          : "pending"
        : installation.suspended_at
          ? "suspended"
          : "ready",
      manageUrl,
    };
  }
  private async token(
    c: Credentials,
    installation: any,
    body: object,
  ): Promise<{
    token: string;
    expires_at: string;
    repositories?: { id: number }[];
    permissions?: Record<string, string>;
  }> {
    if (!Number.isSafeInteger(installation.id)) throw new Error("Invalid GitHub installation");
    const result = (await (
      await this.api(`/app/installations/${installation.id}/access_tokens`, this.jwt(c), {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).json()) as any;
    if (typeof result.token !== "string" || typeof result.expires_at !== "string")
      throw new Error("Invalid GitHub token response");
    return result;
  }
  async listRepositories(
    id: string,
  ): Promise<
    | { state: "ready"; repositories: CatalogRepository[]; manageUrl: string }
    | { state: "pending" | "suspended" | "removed"; manageUrl?: string }
  > {
    const { credentials, installation, manageUrl } = await this.installation(id);
    if (!installation)
      return { state: credentials.installationId ? "removed" : "pending", manageUrl };
    if (installation.suspended_at) return { state: "suspended", manageUrl };
    const token = await this.token(credentials, installation, {});
    const repositories: CatalogRepository[] = [];
    const ids = new Set<string>();
    let total: number | undefined;
    const visited = new Set<string>();
    let next: string | null = "/installation/repositories?per_page=100";
    try {
      while (next) {
        const url = new URL(next, "https://api.github.com").href;
        if (visited.has(url) || visited.size >= 100001)
          throw new Error("Invalid GitHub pagination");
        visited.add(url);
        const r: Response = await this.api(next, token.token);
        const page = (await r.json()) as any;
        if (
          !Number.isSafeInteger(page.total_count) ||
          page.total_count < 0 ||
          page.total_count > 100000 ||
          !Array.isArray(page.repositories) ||
          (total !== undefined && total !== page.total_count)
        )
          throw new Error("Incomplete GitHub repository inventory");
        total = page.total_count;
        for (const repo of page.repositories) {
          if (
            !Number.isSafeInteger(repo.id) ||
            typeof repo.owner?.login !== "string" ||
            typeof repo.name !== "string" ||
            !/^[A-Za-z0-9_.-]+$/.test(repo.owner.login) ||
            !/^[A-Za-z0-9_.-]+$/.test(repo.name) ||
            !(typeof repo.default_branch === "string" || repo.default_branch === null)
          )
            throw new Error("Invalid GitHub repository");
          const externalId = String(repo.id);
          if (ids.has(externalId)) throw new Error("Duplicate GitHub repository");
          ids.add(externalId);
          const webUrl = `https://github.com/${repo.owner.login}/${repo.name}`;
          repositories.push({
            authority: this.authority,
            externalId,
            owner: repo.owner.login,
            name: repo.name,
            webUrl,
            cloneUrl: `${webUrl}.git`,
            defaultBranch: repo.default_branch,
          });
        }
        if (repositories.length > page.total_count)
          throw new Error("Incomplete GitHub repository inventory");
        next = this.next(r);
      }
      if (total !== repositories.length) throw new Error("Incomplete GitHub repository inventory");
      return { state: "ready", repositories, manageUrl };
    } finally {
      await this.releaseGrant(token.token).catch(() => {});
    }
  }
  async resolveRemote(id: string, repoIdentity: string): Promise<string | null> {
    const match =
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
        repoIdentity,
      );
    if (!match) return null;
    const result = await this.listRepositories(id);
    if (result.state !== "ready") throw new Error("GitHub installation unavailable");
    const found = result.repositories.find(
      (r) =>
        r.owner.toLowerCase() === match[1].toLowerCase() &&
        r.name.toLowerCase() === match[2].toLowerCase(),
    );
    if (found) return found.externalId;
    const { credentials, installation } = await this.installation(id);
    if (!installation || installation.suspended_at)
      throw new Error("GitHub installation unavailable");
    const grant = await this.token(credentials, installation, {});
    try {
      let url = new URL(
        `/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
        "https://api.github.com",
      );
      for (let redirects = 0; redirects < 4; redirects++) {
        let response: Response;
        try {
          response = await this.request(url, {
            redirect: "manual",
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              Authorization: `Bearer ${grant.token}`,
            },
          });
        } catch {
          throw new Error("GitHub API unavailable");
        }
        if (response.status === 404) return null;
        if ([301, 302, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error("Invalid GitHub repository redirect");
          url = new URL(location, url);
          if (url.origin !== "https://api.github.com")
            throw new Error("Invalid GitHub repository redirect");
          continue;
        }
        if (!response.ok) throw new Error(`GitHub API failed (${response.status})`);
        const repo = (await response.json()) as { id?: unknown };
        if (!Number.isSafeInteger(repo.id)) throw new Error("Invalid GitHub repository");
        const externalId = String(repo.id);
        return result.repositories.some((item) => item.externalId === externalId)
          ? externalId
          : null;
      }
      throw new Error("Too many GitHub repository redirects");
    } finally {
      await this.releaseGrant(grant.token).catch(() => {});
    }
  }
  async issueCloneGrant(
    id: string,
    repository: CatalogRepository,
  ): Promise<{ token: string; expiresAt: string }> {
    const { credentials, installation } = await this.installation(id);
    if (
      !installation ||
      installation.suspended_at ||
      repository.authority !== this.authority ||
      !/^[1-9][0-9]*$/.test(repository.externalId) ||
      !Number.isSafeInteger(Number(repository.externalId))
    )
      throw new Error("GitHub installation unavailable");
    const result = await this.token(credentials, installation, {
      repository_ids: [Number(repository.externalId)],
      permissions: { contents: "read" },
    });
    if (
      !Array.isArray(result.repositories) ||
      result.repositories.length !== 1 ||
      result.repositories[0]?.id !== Number(repository.externalId) ||
      result.permissions?.contents !== "read" ||
      Object.entries(result.permissions).some(
        ([key, value]) => key !== "contents" && !(key === "metadata" && value === "read"),
      )
    ) {
      await this.releaseGrant(result.token).catch(() => {});
      throw new Error("GitHub did not issue a repository-scoped read-only grant");
    }
    return { token: result.token, expiresAt: result.expires_at };
  }
  async releaseGrant(token: string): Promise<void> {
    await this.api("/installation/token", token, { method: "DELETE" });
  }
  async disconnect(id: string): Promise<void> {
    await rm(this.path(id), { recursive: true, force: true });
  }
}
