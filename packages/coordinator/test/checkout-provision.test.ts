// @module-tag slow
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKOUT_PROVISION_FEATURE, type HostCommand } from "@switchyard/protocol";
import { FakeRepositoryProvider, fixtureRepository } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryProvider } from "../src/index.js";
import { requireService } from "../src/services.js";
import {
  type CommandHandler,
  enrollDevice,
  enrollHost,
  FakeHost,
  hostSession,
  NO_REPLY,
  startCoordinator,
  syncFixtureProject,
  type TestCoordinator,
  until,
} from "./helpers.js";

const repository = fixtureRepository("acme", "app");
const token = "checkout-grant-for-test-plan-DO-NOT-STORE";
const grant = () => ({ token, expiresAt: new Date(Date.now() + 60_000).toISOString() });
const worktree = (path: string, provenance: "main" | "discovered" = "main") => ({
  path,
  branch: "refs/heads/main",
  head: "cafe",
  bare: false,
  detached: false,
  locked: false,
  prunable: false,
  provenance,
  git: null,
});
const info = (root: string, repoIdentity = repository.webUrl) => ({
  root,
  repoIdentity,
  commonDir: `${root}/.git`,
  defaultBranch: "main",
});

let t: TestCoordinator | undefined;
const sockets: FakeHost[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0).reverse()) await socket.close();
  await t?.cleanup();
  t = undefined;
});

type FixtureOpts = { supported?: boolean; publicUrl?: string };
async function setup({ supported = true, publicUrl }: FixtureOpts = {}) {
  let repositories = [repository];
  const issueCloneGrant = vi.fn<RepositoryProvider["issueCloneGrant"]>(async () => grant());
  const releaseGrant = vi.fn<RepositoryProvider["releaseGrant"]>(async () => {});
  const resolveRemote = vi.fn<RepositoryProvider["resolveRemote"]>(async () => null);
  const provider: RepositoryProvider = Object.assign(
    new FakeRepositoryProvider(() => repositories),
    {
      issueCloneGrant,
      releaseGrant,
      resolveRemote,
    },
  );
  const tc = await startCoordinator({ repositoryProvider: provider, publicUrl });
  t = tc;
  const host = await enrollHost(tc);
  const project = await syncFixtureProject(tc.c, repository);
  const connect = async (capable: boolean) => {
    const socket = new FakeHost(tc.c.localUrl.replace("http", "ws"), host.hostId, host.credential);
    sockets.push(socket);
    const welcome = await socket.open({ features: capable ? [CHECKOUT_PROVISION_FEATURE] : [] });
    expect(welcome).toMatchObject({
      type: "welcome",
      features: capable ? [CHECKOUT_PROVISION_FEATURE] : [],
    });
    return socket;
  };
  const socket = await connect(supported);
  const endpoint = `/api/projects/${project.id}/checkouts`;
  const preview = (folderName?: string) =>
    tc.admin("POST", `${endpoint}/preview`, { hostId: host.hostId, folderName });
  const provision = (previewId: string) => tc.admin("POST", `${endpoint}/provision`, { previewId });
  const attach = (path: string) => tc.admin("POST", endpoint, { path, hostId: host.hostId });
  const setRepositories = async (next: typeof repositories) => {
    repositories = next;
    const catalog = requireService(tc.c.ctx, "catalog");
    const id = catalog.status().connections[0]!.id;
    await catalog.refresh(id);
  };
  return {
    tc,
    host,
    socket,
    connect,
    project,
    preview,
    provision,
    endpoint,
    attach,
    issueCloneGrant,
    releaseGrant,
    resolveRemote,
    setRepositories,
  };
}

const targetPath = "/home/vendor/Projects/app";
const simulate: CommandHandler = (cmd) => {
  switch (cmd.type) {
    case "checkout.preview": {
      const root = cmd.root.startsWith("~") ? `/home/vendor${cmd.root.slice(1)}` : cmd.root;
      return { path: `${root}/${cmd.folderName}`, root, state: "missing" };
    }
    case "checkout.provision":
      return info(cmd.expectedPath);
    case "workspace.discover":
      return [worktree(cmd.checkoutPath)];
    default:
      return null;
  }
};
const commandTypes = (host: FakeHost) => host.commands.map(({ command }) => command.type);
const sent = (host: FakeHost, type: HostCommand["type"]) =>
  commandTypes(host).filter((t) => t === type);

function expectNoSecretOnDisk(dir: string) {
  for (const file of readdirSync(dir)) {
    if (!/\.(sqlite|db)(-wal|-shm)?$/.test(file)) continue;
    expect(readFileSync(join(dir, file)).includes(token), file).toBe(false);
  }
}

describe("checkout provisioning", () => {
  it("defaults enrollment to ~/Projects and retires folder APIs without sending host commands", async () => {
    const { tc, host, socket } = await setup();
    const path = `/api/hosts/${host.hostId}`;
    expect((await tc.admin("GET", path)).body).toMatchObject({
      checkoutRoot: "~/Projects",
      checkoutProvision: true,
    });
    expect((await tc.admin("PATCH", path, { checkoutRoot: "~/Elsewhere" })).body).toMatchObject({
      checkoutRoot: "~/Elsewhere",
    });
    expect((await tc.admin("PATCH", path, { checkoutRoot: null })).body).toMatchObject({
      checkoutRoot: null,
    });
    expect((await tc.admin("PATCH", path, { checkoutRoot: "relative" })).body.error.code).toBe(
      "invalid_request",
    );
    expect((await tc.admin("PATCH", path, { projectFolders: ["/tmp"] })).body.error.code).toBe(
      "unsupported_capability",
    );
    expect((await tc.admin("POST", `${path}/scan-projects`)).body.error.code).toBe(
      "unsupported_capability",
    );
    expect((await tc.admin("GET", `${path}/project-suggestions`)).body).toEqual({
      suggestions: [],
    });
    expect(socket.commands).toEqual([]);
  });

  it("only clones a confirmed device-bound preview, then revokes the grant and discovers the real checkout", async () => {
    const {
      tc,
      host,
      socket,
      project,
      preview,
      provision,
      endpoint,
      issueCloneGrant,
      releaseGrant,
    } = await setup();
    socket.handler = simulate;
    expect(
      (await tc.api("POST", `${endpoint}/preview`, { body: { hostId: host.hostId } })).status,
    ).toBe(401);
    const result = await preview();
    expect(result.body).toMatchObject({ action: "clone", path: targetPath });
    expect(issueCloneGrant).not.toHaveBeenCalled();
    expect(tc.c.store.checkouts.list()).toEqual([]);
    const { previewId } = result.body;
    const device = await enrollDevice(tc);
    const useOtherDevice = await tc.api("POST", `${endpoint}/provision`, {
      token: device.credential,
      body: { previewId },
    });
    expect(useOtherDevice.body.error.code).toBe("conflict");
    expect(
      (await tc.admin("POST", "/api/projects/prj_other/checkouts/provision", { previewId })).body
        .error.code,
    ).toBe("conflict");
    const applied = await provision(previewId);
    expect(applied.body).toMatchObject({
      checkout: { hostId: host.hostId, projectId: project.id, path: targetPath },
      workspaces: [{ path: targetPath, provenance: "main" }],
    });
    expect(socket.commands).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "checkout.provision",
          root: "~/Projects",
          folderName: "app",
          expectedPath: targetPath,
          cloneUrl: repository.cloneUrl,
          grant: expect.objectContaining({ token }),
        }),
      }),
    );
    expect(releaseGrant).toHaveBeenCalledExactlyOnceWith(token);
    expect((await provision(previewId)).body.error.code).toBe("conflict");
    expect(sent(socket, "checkout.provision")).toHaveLength(1);
    expect(JSON.stringify(applied.body)).not.toContain(token);
    expectNoSecretOnDisk(tc.dir);
  });

  it("reports collisions without a preview ID and refuses a destination that changed after preview", async () => {
    const { socket, preview, provision, issueCloneGrant } = await setup();
    let appState = "collision";
    socket.handler = (cmd, id) =>
      cmd.type === "checkout.preview" && cmd.folderName === "app"
        ? { root: "/home/vendor/Projects", path: targetPath, state: appState }
        : simulate(cmd, id);
    expect((await preview()).body).toEqual({ action: "collision", path: targetPath });
    const alternate = await preview("alternate");
    expect(alternate.body).toMatchObject({
      action: "clone",
      path: "/home/vendor/Projects/alternate",
    });
    appState = "missing";
    const { previewId } = (await preview()).body;
    appState = "collision";
    expect((await provision(previewId)).body.error.code).toBe("conflict");
    expect(issueCloneGrant).not.toHaveBeenCalled();
  });

  it("rejects expired previews, changed roots, and clone over plaintext non-loopback", async () => {
    const { tc, host, socket, preview, provision, issueCloneGrant } = await setup();
    socket.handler = simulate;
    const expired = (await preview()).body.previewId;
    tc.clock.advance(5 * 60_000);
    expect((await provision(expired)).body.error.code).toBe("conflict");
    const changedRoot = (await preview()).body.previewId;
    await tc.admin("PATCH", `/api/hosts/${host.hostId}`, { checkoutRoot: "/home/vendor/other" });
    expect((await provision(changedRoot)).body.error.code).toBe("conflict");
    tc.c.ctx.config.publicUrl = "http://192.168.0.10:9990";
    expect((await preview()).body.error.code).toBe("unsupported_capability");
    expect(issueCloneGrant).not.toHaveBeenCalled();
  });

  it("rechecks listed identity after issuing a grant but before sending it", async () => {
    const { socket, preview, provision, issueCloneGrant, releaseGrant, setRepositories } =
      await setup();
    socket.handler = simulate;
    issueCloneGrant.mockImplementationOnce(async () => {
      await setRepositories([
        {
          ...repository,
          name: "renamed",
          webUrl: "https://github.com/acme/renamed",
          cloneUrl: "https://github.com/acme/renamed.git",
        },
      ]);
      return grant();
    });
    const { previewId } = (await preview()).body;
    expect((await provision(previewId)).body.error.code).toBe("conflict");
    expect(sent(socket, "checkout.provision")).toHaveLength(0);
    expect(releaseGrant).toHaveBeenCalledExactlyOnceWith(token);
  });

  it("rechecks secure transport immediately before grant delivery and redacts invalid grant errors", async () => {
    const { tc, socket, preview, provision, issueCloneGrant, releaseGrant } = await setup({
      publicUrl: "http://127.0.0.2:9990",
    });
    socket.handler = simulate;
    const choose = (await preview()).body.previewId;
    issueCloneGrant.mockImplementationOnce(async () => {
      tc.c.ctx.config.publicUrl = "http://192.168.0.10:9990";
      return grant();
    });
    expect((await provision(choose)).body.error.code).toBe("unsupported_capability");
    expect(releaseGrant).toHaveBeenCalledExactlyOnceWith(token);

    tc.c.ctx.config.publicUrl = "https://example.test";
    issueCloneGrant.mockResolvedValueOnce({ ...grant(), token: `${token}\n` });
    const invalid = await provision((await preview()).body.previewId);
    expect(invalid.body.error.code).toBe("invalid_request");
    expect(JSON.stringify(invalid.body)).not.toContain(token);
    expect(sent(socket, "checkout.provision")).toHaveLength(0);
    expect(releaseGrant).toHaveBeenCalledTimes(2);
    expectNoSecretOnDisk(tc.dir);
  });

  it("serializes a destination and does not replay or revoke a grant after a lost receipt", async () => {
    const { tc, socket, connect, preview, provision, issueCloneGrant, releaseGrant } =
      await setup();
    socket.handler = (cmd, id) =>
      cmd.type === "checkout.provision" ? NO_REPLY : simulate(cmd, id);
    const a = (await preview()).body.previewId;
    const b = (await preview()).body.previewId;
    const pending = provision(a);
    await socket.waitForCommand("checkout.provision");
    expect((await provision(b)).body.error.code).toBe("conflict");
    const replacement = await connect(true);
    expect((await pending).body.error.details).toEqual({
      path: targetPath,
      checkCheckoutStatus: true,
    });
    expect(replacement.commands).toEqual([]);
    expect(tc.c.store.checkouts.list()).toEqual([]);
    // The clone may have finished even though we never received a receipt. Inspect anew.
    replacement.handler = (cmd, id) =>
      cmd.type === "checkout.preview"
        ? {
            root: "/home/vendor/Projects",
            path: targetPath,
            state: "existing",
            checkout: info(targetPath),
          }
        : simulate(cmd, id);
    const status = await preview();
    expect(status.body).toMatchObject({ action: "reuse", path: targetPath });
    expect((await provision(status.body.previewId)).body.checkout.path).toBe(targetPath);
    expect(sent(replacement, "checkout.provision")).toHaveLength(0);
    expect(issueCloneGrant).toHaveBeenCalledTimes(1);
    expect(releaseGrant).not.toHaveBeenCalled();
    expectNoSecretOnDisk(tc.dir);
  });

  it("redacts a confirmed host failure, revokes its grant, and retries discovery without cloning again", async () => {
    const { tc, socket, preview, provision, issueCloneGrant, releaseGrant } = await setup();
    let step = 0;
    socket.handler = (cmd, id) => {
      if (cmd.type === "checkout.provision" && ++step === 1)
        return { __error: { code: "conflict", message: `Git received ${token}` } };
      if (cmd.type === "checkout.locate" && step >= 2)
        return { checkout: info(targetPath), worktreePath: targetPath };
      if (cmd.type === "workspace.discover" && step === 2) {
        step++;
        return { __error: { code: "conflict", message: "try again" } };
      }
      return simulate(cmd, id);
    };
    const first = await provision((await preview()).body.previewId);
    expect(JSON.stringify(first.body)).not.toContain(token);
    expect(releaseGrant).toHaveBeenCalledExactlyOnceWith(token);
    expect(tc.c.store.checkouts.list()).toHaveLength(0);
    expect((await provision((await preview()).body.previewId)).body.error.details).toMatchObject({
      path: targetPath,
      checkCheckoutStatus: true,
    });
    const existing = tc.c.store.checkouts.list()[0];
    expect(existing?.path).toBe(targetPath);
    expect(tc.c.store.workspaces.list()).toHaveLength(0);
    const latest = await preview();
    expect(latest.body.action).toBe("reuse");
    expect((await provision(latest.body.previewId)).body.checkout.id).toBe(existing?.id);
    expect(issueCloneGrant).toHaveBeenCalledTimes(2);
    expectNoSecretOnDisk(tc.dir);
  });

  it("gates modern checkout commands on hello and replacement; legacy hosts can still attach and reuse", async () => {
    const { tc, host, socket, connect, preview, provision, attach } = await setup();
    socket.handler = () => NO_REPLY;
    const request = tc.c.hostHub.request(host.hostId, {
      type: "checkout.preview",
      root: "~/Projects",
      folderName: "app",
    });
    const rejected = expect(request).rejects.toMatchObject({ code: "unsupported_capability" });
    await socket.waitForCommand("checkout.preview");
    const legacy = await connect(false);
    await rejected;
    expect(legacy.commands).toEqual([]);
    expect((await tc.admin("GET", `/api/hosts/${host.hostId}`)).body.checkoutProvision).toBe(false);
    expect((await preview()).body.error.code).toBe("unsupported_capability");
    await expect(
      tc.c.hostHub.request(host.hostId, { type: "checkout.locate", cwd: "/repo" }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    legacy.handler = (cmd, id) =>
      cmd.type === "checkout.inspect" ? info(cmd.path) : simulate(cmd, id);
    const outside = "/unrelated-location/local-name";
    const attached = await attach(outside);
    expect(attached.status).toBe(201);
    await tc.admin("PATCH", `/api/hosts/${host.hostId}`, { checkoutRoot: null });
    const prepared = await preview();
    expect(prepared.body).toMatchObject({ action: "reuse", path: outside });
    expect((await provision(prepared.body.previewId)).body.checkout.id).toBe(
      attached.body.checkout.id,
    );
    expect(commandTypes(legacy)).not.toContain("checkout.provision");
  });

  it("legacy create only attaches verified listed work and never changes project settings", async () => {
    const { tc, host, socket, project, attach, resolveRemote, setRepositories } = await setup({
      supported: false,
    });
    const original = repository.webUrl;
    socket.handler = (cmd, id) =>
      cmd.type === "checkout.inspect" ? info(cmd.path, original) : simulate(cmd, id);
    await setRepositories([
      {
        ...repository,
        name: "renamed",
        webUrl: `${original}-renamed`,
        cloneUrl: `${original}-renamed.git`,
      },
    ]);
    expect((await attach("/elsewhere/old")).body.error.code).toBe("repo_mismatch");
    const legacyBody = {
      hostId: host.hostId,
      path: "/elsewhere/old",
      name: "wrong name",
      setupCommand: "wrong command",
    };
    const refused = await tc.admin("POST", "/api/projects", legacyBody);
    expect(refused.body.error).toMatchObject({
      code: "conflict",
      message: "Projects come from your Git provider.",
    });
    expect(tc.c.store.checkouts.list()).toHaveLength(0);
    resolveRemote.mockResolvedValue(repository.externalId);
    const attached = await tc.admin("POST", "/api/projects", legacyBody);
    expect(attached.body).toMatchObject({
      id: project.id,
      name: "acme/renamed",
      setupCommand: null,
      checkouts: [{ path: legacyBody.path }],
    });
    await setRepositories([]);
    await setRepositories([]);
    expect((await tc.admin("GET", "/api/projects")).body).toEqual([]);
    expect((await tc.admin("GET", "/api/projects?includeHistory=true")).body).toMatchObject([
      { id: project.id, catalog: { state: "delisted" } },
    ]);
    expect((await tc.admin("GET", `/api/projects/${project.id}`)).status).toBe(200);
    expect((await attach(legacyBody.path)).body.error.code).toBe("conflict");
  });

  it("deduplicates targeted inspection of hand-started sessions and rehomes the same IDs to the verified worktree", async () => {
    const { tc, socket, project, issueCloneGrant } = await setup();
    const linked = "/tmp/worktrees/topic";
    let locateId: string | undefined;
    socket.handler = (cmd, id) => {
      if (cmd.type === "checkout.locate") {
        locateId = id;
        return NO_REPLY;
      }
      if (cmd.type === "workspace.discover")
        return [worktree(cmd.checkoutPath), worktree(linked, "discovered")];
      return simulate(cmd, id);
    };
    for (const id of ["ses_external_a", "ses_external_b"]) {
      await socket.event(
        "session.updated",
        hostSession(id, {
          cwd: `${linked}/src`,
          provenance: "imported",
          projectId: "prj_untrusted",
          workspaceId: "wsp_untrusted",
        }),
      );
      expect(tc.c.store.sessions.require(id).projectId).toBeNull();
    }
    await socket.waitForCommand("checkout.locate");
    socket.sendRaw({
      type: "receipt",
      receipt: {
        commandId: locateId,
        ok: true,
        result: { checkout: info("/elsewhere/main"), worktreePath: linked },
      },
    });
    await until(() => tc.c.store.sessions.get("ses_external_b")?.projectId === project.id);
    const sessions = tc.c.store.sessions.list();
    expect(sessions.map((s) => s.id).sort()).toEqual(["ses_external_a", "ses_external_b"]);
    expect(sessions.every((s) => tc.c.store.workspaces.get(s.workspaceId!)?.path === linked)).toBe(
      true,
    );
    expect(sent(socket, "checkout.locate")).toHaveLength(1);
    expect(issueCloneGrant).not.toHaveBeenCalled();
  });
});
