import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
  type CatalogRepository,
  CheckoutInfo,
  CheckoutLocateResult,
  CheckoutPreviewResult,
  type Host,
  type Project,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { isLoopbackUrl } from "./owner.js";
import { getService } from "./services.js";
import { requireConnected } from "./sessions/service.js";
import {
  inspectCheckout,
  recordInspectedCheckout,
  refreshCheckoutWorkspaces,
} from "./workspaces.js";

const PREVIEW_MS = 5 * 60_000;
const PREVIEW_LIMIT = 1024;
const INSPECT_MS = 10_000;
const CLONE_MS = 5 * 60_000;
const LOCATE_LIMIT = 16;
const PROJECT_SOURCE = "Projects come from your Git provider.";

type Repository = { project: Project; connectionId: string; repo: CatalogRepository };
type Target = { path: string; root: string } & (
  | { action: "reuse"; info: CheckoutInfo; registered: boolean }
  | { action: "clone" }
  | { action: "collision" }
);
type Prepared = {
  deviceId: string;
  projectId: string;
  hostId: string;
  checkoutRoot: string | null;
  repository: CatalogRepository;
  folderName: string;
  expires: number;
  target: Exclude<Target, { action: "collision" }>;
};

function absolute(path: string) {
  return !path.includes("\0") && posix.isAbsolute(path) && posix.resolve(path) === path;
}

function contains(directory: string, path: string) {
  return (
    absolute(directory) &&
    absolute(path) &&
    (directory === "/" || path === directory || path.startsWith(`${directory}/`))
  );
}

function inspected(info: CheckoutInfo): CheckoutInfo {
  if (!absolute(info.root) || !absolute(info.commonDir) || !info.defaultBranch) {
    throw new SwitchyardError("conflict", "The host did not report a usable checkout");
  }
  return info;
}

function sameRepository(a: CatalogRepository, b: CatalogRepository) {
  return (
    a.authority === b.authority &&
    a.externalId === b.externalId &&
    a.cloneUrl === b.cloneUrl &&
    a.defaultBranch === b.defaultBranch
  );
}

function changed() {
  return new SwitchyardError(
    "conflict",
    "The checkout preview changed. Check checkout status and preview again.",
  );
}

function unknownCheckout(err: unknown): err is SwitchyardError {
  return (
    err instanceof SwitchyardError &&
    !!err.details &&
    typeof err.details === "object" &&
    "checkCheckoutStatus" in err.details &&
    err.details.checkCheckoutStatus === true
  );
}

export class CheckoutProvisionService {
  private readonly previews = new Map<string, Prepared>();
  private readonly destinations = new Set<string>();
  private readonly locating = new Set<string>();

  constructor(private readonly ctx: CoordinatorContext) {}

  private catalog() {
    const catalog = getService(this.ctx, "catalog");
    if (!catalog)
      throw new SwitchyardError("unsupported_capability", "Git provider catalog is unavailable");
    return catalog;
  }

  private repository(projectId: string): Repository {
    const catalog = this.catalog();
    const project = catalog.requireListedProject(projectId);
    return { project, ...catalog.repository(project) };
  }

  private host(hostId: string): Host {
    const host = this.ctx.store.hosts.require(hostId);
    if (host.revokedAt) throw new SwitchyardError("forbidden", "This host was revoked");
    requireConnected(this.ctx, hostId);
    return host;
  }

  private requireProvision(hostId: string) {
    if (!this.ctx.hostHub.supportsCheckoutProvision(hostId)) {
      throw new SwitchyardError(
        "unsupported_capability",
        "Update the host agent to prepare a checkout, or attach an existing checkout by path",
      );
    }
  }

  private requireSecureGrantTransport() {
    const url = new URL(this.ctx.config.publicUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackUrl(url.href))) {
      throw new SwitchyardError(
        "unsupported_capability",
        "Configure HTTPS before using this coordinator to clone repositories",
      );
    }
  }

  private assertCurrent(initial: Repository, hostId: string) {
    this.host(hostId);
    const current = this.repository(initial.project.id);
    if (!sameRepository(initial.repo, current.repo)) throw changed();
    return current;
  }

  private current(preview: Prepared): Repository {
    const host = this.host(preview.hostId);
    const current = this.repository(preview.projectId);
    if (
      (host.checkoutRoot ?? null) !== preview.checkoutRoot ||
      !sameRepository(preview.repository, current.repo)
    ) {
      throw changed();
    }
    if (preview.target.action !== "reuse" || !preview.target.registered)
      this.requireProvision(host.id);
    return current;
  }

  private async locate(hostId: string, cwd: string) {
    const raw = await this.ctx.hostHub.request(
      hostId,
      { type: "checkout.locate", cwd },
      { timeoutMs: INSPECT_MS },
    );
    const located = CheckoutLocateResult.parse(raw);
    if (!located || !contains(located.worktreePath, cwd)) return null;
    return { ...located, checkout: inspected(located.checkout) };
  }

  private async inspect(hostId: string, path: string) {
    if (absolute(path) && this.ctx.hostHub.supportsCheckoutProvision(hostId)) {
      const result = await this.locate(hostId, path);
      if (!result)
        throw new SwitchyardError("not_a_git_repo", "The path is not in an available checkout");
      return result.checkout;
    }
    return inspected(await inspectCheckout(this.ctx, hostId, path));
  }

  private ownerAt(hostId: string, path: string) {
    return this.ctx.store.checkouts.list("host_id = ? AND path = ?", [hostId, path])[0];
  }

  private async target(host: Host, project: Project, folderName: string): Promise<Target> {
    const catalog = this.catalog();
    const { id, checkoutRoot } = host;
    for (const checkout of this.ctx.store.checkouts.list("host_id = ? AND project_id = ?", [
      id,
      project.id,
    ])) {
      try {
        const info = await this.inspect(id, checkout.path);
        if (
          info.root === checkout.path &&
          (await catalog.matchesRemote(project, info.repoIdentity))
        ) {
          return {
            action: "reuse",
            path: info.root,
            root: posix.dirname(info.root),
            info,
            registered: true,
          };
        }
      } catch (err) {
        if (
          !(err instanceof SwitchyardError) ||
          !["not_a_git_repo", "not_found"].includes(err.code)
        )
          throw err;
      }
    }
    this.requireProvision(id);
    if (!checkoutRoot)
      throw new SwitchyardError(
        "conflict",
        "Set a Checkout location for this host or attach an existing checkout by path",
      );
    if (/[\\/\0]/.test(folderName) || [".", "..", ".git"].includes(folderName.toLowerCase())) {
      throw new SwitchyardError("invalid_request", "Choose a single checkout folder name");
    }
    const raw = await this.ctx.hostHub.request(
      id,
      { type: "checkout.preview", root: checkoutRoot, folderName },
      { timeoutMs: INSPECT_MS },
    );
    const { root, path, state, checkout: info } = CheckoutPreviewResult.parse(raw);
    if (!absolute(root) || !absolute(path) || posix.join(root, folderName) !== path) {
      throw new SwitchyardError(
        "conflict",
        "Host reported a checkout outside the configured location",
      );
    }
    const owner = this.ownerAt(id, path);
    if (owner && owner.projectId !== project.id) return { action: "collision", path, root };
    if (state === "missing") return { action: "clone", path, root };
    if (
      state === "existing" &&
      info?.root === path &&
      (await catalog.matchesRemote(project, info.repoIdentity))
    ) {
      return { action: "reuse", path, root, info: inspected(info), registered: false };
    }
    return { action: "collision", path, root };
  }

  private prunePreviews(now: number) {
    for (const [id, value] of this.previews) if (value.expires <= now) this.previews.delete(id);
  }

  async preview(deviceId: string, projectId: string, hostId: string, folderName?: string) {
    const initial = this.repository(projectId);
    const host = this.host(hostId);
    const name = folderName ?? initial.repo.name;
    const target = await this.target(host, initial.project, name);
    this.assertCurrent(initial, hostId);
    if ((this.host(hostId).checkoutRoot ?? null) !== (host.checkoutRoot ?? null)) throw changed();
    if (target.action === "collision") return { action: target.action, path: target.path };
    if (target.action === "clone") {
      this.requireSecureGrantTransport();
      if (!initial.repo.defaultBranch)
        throw new SwitchyardError("conflict", "No default branch to start work on");
    }
    const now = this.ctx.store.now().getTime();
    this.prunePreviews(now);
    if (this.previews.size >= PREVIEW_LIMIT)
      this.previews.delete(this.previews.keys().next().value!);
    const previewId = randomBytes(32).toString("base64url");
    this.previews.set(previewId, {
      deviceId,
      projectId,
      hostId,
      folderName: name,
      repository: initial.repo,
      checkoutRoot: host.checkoutRoot ?? null,
      expires: now + PREVIEW_MS,
      target,
    });
    return { action: target.action, path: target.path, previewId };
  }

  private async atDestination<T>(hostId: string, path: string, act: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([hostId, path]);
    if (this.destinations.has(key))
      throw new SwitchyardError(
        "conflict",
        "Checkout preparation is already in progress at this path",
      );
    this.destinations.add(key);
    try {
      return await act();
    } finally {
      this.destinations.delete(key);
    }
  }

  async provision(deviceId: string, projectId: string, previewId: string) {
    this.prunePreviews(this.ctx.store.now().getTime());
    const preview = this.previews.get(previewId);
    if (!preview || preview.deviceId !== deviceId || preview.projectId !== projectId) {
      throw new SwitchyardError(
        "conflict",
        "The checkout preview is invalid or expired. Preview again.",
      );
    }
    this.previews.delete(previewId);
    const { hostId, target: expected } = preview;
    return this.atDestination(hostId, expected.path, async () => {
      const initial = this.current(preview);
      const actual = await this.target(this.host(hostId), initial.project, preview.folderName);
      if (
        actual.action === "collision" ||
        actual.action !== expected.action ||
        actual.path !== expected.path ||
        actual.root !== expected.root
      )
        throw changed();
      if (
        actual.action === "reuse" &&
        expected.action === "reuse" &&
        (actual.registered !== expected.registered ||
          actual.info.commonDir !== expected.info.commonDir)
      )
        throw changed();
      const info =
        actual.action === "reuse" ? actual.info : await this.clone(preview, this.current(preview));
      const current = this.current(preview);
      const checkout = recordInspectedCheckout(this.ctx, current.project.id, hostId, info);
      let workspaces: Awaited<ReturnType<typeof refreshCheckoutWorkspaces>>;
      try {
        workspaces = await refreshCheckoutWorkspaces(this.ctx, checkout, {
          beforeRecord: () => this.current(preview),
          requiredWorktreePath: checkout.path,
        });
      } catch {
        throw new SwitchyardError(
          "conflict",
          "Checkout is present, but workspace discovery failed. Check checkout status and try discovery again.",
          {
            path: checkout.path,
            checkCheckoutStatus: true,
          },
        );
      }
      return { checkout, workspaces };
    });
  }

  private async clone(preview: Prepared, initial: Repository): Promise<CheckoutInfo> {
    this.requireSecureGrantTransport();
    const catalog = this.catalog();
    const grant = await catalog.grant(initial.project);
    let uncertain = false;
    try {
      // Issuing the grant is asynchronous: refresh membership, capability and location before send.
      const current = this.current(preview);
      if (initial.connectionId !== current.connectionId || !preview.checkoutRoot) throw changed();
      if (Date.parse(grant.expiresAt) <= this.ctx.store.now().getTime()) {
        throw new SwitchyardError("conflict", "Checkout authorization expired. Preview again.");
      }
      this.requireSecureGrantTransport();
      const owner = this.ownerAt(preview.hostId, preview.target.path);
      if (owner && owner.projectId !== preview.projectId) throw changed();
      const receipt = await this.ctx.hostHub
        .send(
          preview.hostId,
          {
            type: "checkout.provision",
            root: preview.checkoutRoot,
            folderName: preview.folderName,
            expectedPath: preview.target.path,
            cloneUrl: current.repo.cloneUrl,
            grant,
          },
          { timeoutMs: CLONE_MS },
        )
        .catch((err: unknown) => {
          // No receipt and a possible send: leave the in-flight grant alone and let it expire.
          if (!unknownCheckout(err)) throw err;
          uncertain = true;
          throw new SwitchyardError(err.code, err.message, {
            path: preview.target.path,
            checkCheckoutStatus: true,
          });
        });
      if (!receipt.ok) {
        const noDefaultBranch = receipt.error.message === "No default branch to start work on";
        throw new SwitchyardError(
          receipt.error.code,
          noDefaultBranch
            ? receipt.error.message
            : "The host could not prepare the clone. Check checkout status before retrying.",
          {
            path: preview.target.path,
            checkCheckoutStatus: true,
          },
        );
      }
      const info = CheckoutInfo.safeParse(receipt.result);
      if (
        !info.success ||
        Object.values(info.data).some((value) => value.includes(grant.token)) ||
        info.data.root !== preview.target.path ||
        info.data.repoIdentity.toLowerCase() !== current.repo.webUrl.toLowerCase()
      ) {
        throw new SwitchyardError(
          "repo_mismatch",
          "The host did not report the expected checkout. Check checkout status before retrying.",
          {
            path: preview.target.path,
            checkCheckoutStatus: true,
          },
        );
      }
      return inspected(info.data);
    } finally {
      if (!uncertain) {
        try {
          await catalog.provider?.releaseGrant(grant.token);
        } catch {
          this.ctx.log.warn("Could not release the clone grant; it will expire");
        }
      }
    }
  }

  private async matchListed(info: CheckoutInfo): Promise<Repository | null> {
    const catalog = this.catalog();
    const direct = this.ctx.store.projects.list(
      "json_extract(json, '$.catalog.state') = 'listed' AND lower(repo_identity) = lower(?)",
      [info.repoIdentity],
    );
    if (direct.length > 1) return null;
    if (direct.length === 1) {
      const candidate = this.repository(direct[0]!.id);
      return (await catalog.matchesRemote(candidate.project, info.repoIdentity)) ? candidate : null;
    }
    if (!catalog.provider) return null;
    // A provider resolves one URL to one immutable ID, not once per project in an installation.
    for (const { id, state } of catalog.status().connections) {
      if (state !== "ready" && state !== "stale") continue;
      const externalId = await catalog.provider
        .resolveRemote(id, info.repoIdentity)
        .catch(() => null);
      if (!externalId) continue;
      const matches = this.ctx.store.projects.list(
        "json_extract(json, '$.catalog.state') = 'listed' AND json_extract(json, '$.catalog.authority') = ? AND json_extract(json, '$.catalog.externalId') = ?",
        [catalog.provider.authority, externalId],
      );
      return matches.length === 1 ? this.repository(matches[0]!.id) : null;
    }
    return null;
  }

  private record(
    initial: Repository,
    hostId: string,
    info: CheckoutInfo,
    requiredWorktreePath?: string,
  ) {
    return this.atDestination(hostId, info.root, async () => {
      const current = this.assertCurrent(initial, hostId);
      const checkout = recordInspectedCheckout(this.ctx, current.project.id, hostId, info);
      const workspaces = await refreshCheckoutWorkspaces(this.ctx, checkout, {
        beforeRecord: () => this.assertCurrent(initial, hostId),
        requiredWorktreePath,
      });
      return { checkout, workspaces };
    });
  }

  async attach(projectId: string, hostId: string, path: string) {
    const initial = this.repository(projectId);
    this.host(hostId);
    const info = await this.inspect(hostId, path);
    if (!(await this.catalog().matchesRemote(initial.project, info.repoIdentity))) {
      throw new SwitchyardError(
        "repo_mismatch",
        "The checkout's origin does not match the listed repository",
      );
    }
    return this.record(initial, hostId, info);
  }

  async attachFromLegacyCreate(hostId: string, path: string): Promise<Project> {
    try {
      this.host(hostId);
      const info = await this.inspect(hostId, path);
      const initial = await this.matchListed(info);
      if (initial) {
        return await this.atDestination(hostId, info.root, async () => {
          const current = this.assertCurrent(initial, hostId);
          const checkout = recordInspectedCheckout(this.ctx, current.project.id, hostId, info);
          // Keep the old response available if discovery, but not attachment, fails.
          await refreshCheckoutWorkspaces(this.ctx, checkout, {
            beforeRecord: () => this.assertCurrent(current, hostId),
          }).catch(() => {
            this.ctx.log.warn(
              { checkoutId: checkout.id },
              "Workspace discovery failed for attached checkout",
            );
          });
          return this.assertCurrent(current, hostId).project;
        });
      }
    } catch {
      // The retired path cannot select a new repo or resolve an ambiguous attachment.
    }
    throw new SwitchyardError("conflict", PROJECT_SOURCE);
  }

  async adoptImported(session: Session) {
    const { hostId, cwd } = session;
    const key = JSON.stringify([hostId, cwd]);
    if (
      !absolute(cwd) ||
      cwd.length > 4096 ||
      this.locating.has(key) ||
      this.locating.size >= LOCATE_LIMIT ||
      !this.ctx.hostHub.supportsCheckoutProvision(hostId)
    )
      return;
    this.locating.add(key);
    try {
      const located = await this.locate(hostId, cwd);
      if (!located) return;
      const candidate = await this.matchListed(located.checkout);
      if (!candidate) return;
      const current = this.ctx.store.sessions.get(session.id);
      if (
        !current ||
        current.hostId !== hostId ||
        current.cwd !== cwd ||
        current.projectId ||
        current.archivedAt
      )
        return;
      await this.record(candidate, hostId, located.checkout, located.worktreePath);
    } catch {
      // Offline, unresolved and ambiguous origins leave the session projectless.
    } finally {
      this.locating.delete(key);
    }
  }
}
