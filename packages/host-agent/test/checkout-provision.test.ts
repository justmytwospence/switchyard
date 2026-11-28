// @module-tag slow
import { execFileSync, type SpawnOptions, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { CHECKOUT_PROVISION_FEATURE, type HostCommandOf, type Receipt } from "@switchyard/protocol";
import { makeRepo } from "@switchyard/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateCheckout, previewCheckout, provisionCheckout } from "../src/checkout-provision.js";
import { CommandRouter, type CommandRouterOptions } from "../src/commands.js";
import { openHostDb } from "../src/db/index.js";
import { CoordinatorLink } from "../src/link.js";
import { createLogger, silentLogger } from "../src/logger.js";
import { FakeCoordinator, tempDir } from "./helpers.js";

const cloneUrl = "https://github.com/Owner/Repo.git";
const TOKEN = "fixture-grant-not-a-real-secret";
const authorization = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const testTransport = vi.hoisted(() => ({
  clone: undefined as ((args: string[], opts: SpawnOptions) => void) | undefined,
}));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return {
    ...real,
    spawn(file: string, args: string[], opts: SpawnOptions) {
      if (file === "git" && args[1] === "clone") {
        if (!testTransport.clone) throw new Error("Tests must not clone over the public network");
        testTransport.clone(args, opts);
      }
      return real.spawn(file, args, opts);
    },
  };
});

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  testTransport.clone = undefined;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) await cleanups.pop()?.();
});

function directory() {
  const dir = tempDir("switchyard-checkout-");
  cleanups.push(dir.cleanup);
  return dir.path;
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repo(remote = cloneUrl) {
  const r = makeRepo({ remote });
  cleanups.push(r.cleanup);
  return r.path;
}

function command(root: string, folderName = "Repo"): HostCommandOf<"checkout.provision"> {
  return {
    type: "checkout.provision",
    root,
    folderName,
    expectedPath: join(root, folderName),
    cloneUrl,
    grant: { token: TOKEN, expiresAt: new Date(Date.now() + 30_000).toISOString() },
  };
}

async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** Real Git HTTPS traffic, preserving the canonical target and cert verification. Only the
 * test's Git subprocesses get a private proxy and a test CA. */
async function privateRemote(mode: "ok" | "empty" | "deny" | "stall" | "redirect" = "ok") {
  const scratch = directory();
  const remote = join(scratch, "Owner", "Repo.git");
  mkdirSync(join(scratch, "Owner"));
  if (mode === "empty") git(scratch, ["init", "--bare", "--initial-branch=trunk", remote]);
  else {
    const source = repo();
    git(source, ["branch", "-m", "trunk"]);
    git(scratch, ["clone", "-q", "--bare", source, remote]);
  }
  const cert = join(scratch, "cert.pem");
  const key = join(scratch, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=github.com",
      "-addext",
      "subjectAltName=DNS:github.com",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const calls: string[] = [];
  const httpsPort = await listen(
    createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      const url = new URL(req.url!, cloneUrl);
      calls.push(url.pathname);
      if (req.headers.authorization !== authorization || mode === "deny") {
        res.writeHead(403).end(TOKEN);
        return;
      }
      if (mode === "stall") return;
      if (mode === "redirect") {
        res
          .writeHead(302, { location: "https://github.com/elsewhere/credentials.git/info/refs" })
          .end();
        return;
      }
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(chunk);
      const out = spawnSync("git", ["http-backend"], {
        input: Buffer.concat(body),
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PROJECT_ROOT: scratch,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method!,
          CONTENT_TYPE: req.headers["content-type"],
          REMOTE_USER: "x-access-token",
        },
      });
      const separator = out.stdout.indexOf("\r\n\r\n");
      if (out.status !== 0 || separator < 0) {
        res.writeHead(500).end();
        return;
      }
      for (const line of out.stdout.subarray(0, separator).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        if (line.startsWith("Status: ")) res.statusCode = Number(line.slice(8, 11));
        else if (colon >= 0) res.setHeader(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      res.end(out.stdout.subarray(separator + 4));
    }),
  );
  const proxy = createHttpServer();
  proxy.on("connect", (req, socket, head) => {
    if (req.url !== "github.com:443") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const remoteSocket = connect(httpsPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remoteSocket.write(head);
      socket.pipe(remoteSocket).pipe(socket);
    });
    remoteSocket.on("error", () => socket.destroy());
    socket.on("error", () => remoteSocket.destroy());
    socket.on("close", () => remoteSocket.destroy());
  });
  const proxyPort = await listen(proxy);
  const clones: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  testTransport.clone = (args, opts) => {
    clones.push({ args, env: { ...opts.env } });
    opts.env = { ...opts.env, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, GIT_SSL_CAINFO: cert };
  };
  return { calls, clones };
}

function router() {
  const path = join(directory(), "host.db");
  const db = openHostDb(path);
  cleanups.push(() => db.close());
  const logs: string[] = [];
  const receipts: Receipt[] = [];
  const observed: unknown[] = [];
  let drop = false;
  const handler = new CommandRouter({
    db,
    supervisor: {} as CommandRouterOptions["supervisor"],
    dispatcher: {} as CommandRouterOptions["dispatcher"],
    workspaces: {} as CommandRouterOptions["workspaces"],
    log: createLogger({ level: "debug", destination: { write: (line) => logs.push(line) } }),
    sendReceipt: (receipt) => receipts.push(receipt),
    testHooks: { onCommand: (c) => observed.push(c), dropReceipt: () => drop },
  });
  return {
    db,
    handler,
    path,
    logs,
    receipts,
    observed,
    drop: () => {
      drop = true;
    },
  };
}

function expectNoGrant(data: string | Buffer) {
  const value = data.toString();
  expect(value).not.toContain(TOKEN);
  expect(value).not.toContain(authorization);
}

async function checkoutLink(plainHostname = false) {
  const coordinator = await FakeCoordinator.start();
  cleanups.push(() => coordinator.close());
  const db = openHostDb(join(directory(), "link.db"));
  cleanups.push(() => db.close());
  const received: unknown[] = [];
  let advertised = true;
  const link = new CoordinatorLink({
    db,
    coordinatorUrl: plainHostname
      ? coordinator.url.replace("127.0.0.1", "localhost")
      : coordinator.url,
    hostId: "test-host",
    credential: "test-host-credential",
    log: silentLogger(),
    backoffMs: [0],
    hello: () => ({
      name: "test-host",
      agentVersion: "test",
      piVersion: null,
      piCompatible: false,
      platform: "linux",
      capabilities: null,
      protocolVersion: 1,
      features: advertised ? [CHECKOUT_PROVISION_FEATURE] : [],
    }),
    onCommand: (commandId, c) => {
      received.push(c);
      link.sendReceipt({ commandId, ok: true, result: null });
    },
  });
  cleanups.push(() => link.stop());
  const ready = once(link.events, "welcome");
  link.start();
  await ready;
  return {
    coordinator,
    link,
    received,
    downgrade: () => {
      advertised = false;
    },
  };
}

describe("checkout commands on the host link", () => {
  it("only accepts checkout commands when this connection advertises support, including after reconnect", async () => {
    const { coordinator, link, downgrade, received } = await checkoutLink();
    expect(coordinator.hellos[0]?.features).toContain(CHECKOUT_PROVISION_FEATURE);
    const c = command(directory());
    expect(await coordinator.command(c)).toMatchObject({ ok: true });
    expect(received).toHaveLength(1);
    const next = once(link.events, "welcome");
    downgrade();
    coordinator.socket?.terminate();
    await next;
    expect(coordinator.hellos[1]?.features).not.toContain(CHECKOUT_PROVISION_FEATURE);
    for (const cmd of [
      c,
      { type: "checkout.preview", root: c.root, folderName: c.folderName },
      { type: "checkout.locate", cwd: c.root },
    ] as const) {
      expect(await coordinator.command(cmd)).toMatchObject({
        ok: false,
        error: { code: "unsupported_capability" },
      });
    }
    expect(received).toHaveLength(1);
  });

  it("blocks plaintext hostname clone grants but allows preview and location", async () => {
    const { coordinator, received } = await checkoutLink(true);
    const c = command(directory());
    const denied = await coordinator.command(c);
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expectNoGrant(JSON.stringify(denied));
    expect(received).toHaveLength(0);
    expect(
      await coordinator.command({
        type: "checkout.preview",
        root: c.root,
        folderName: c.folderName,
      }),
    ).toMatchObject({ ok: true });
    expect(await coordinator.command({ type: "checkout.locate", cwd: c.root })).toMatchObject({
      ok: true,
    });
    expect(received).toHaveLength(2);
  });
});

describe("checkout preview and location", () => {
  it("resolves the configured root, never makes it, rejects traversal and detects collisions", async () => {
    const root = directory();
    const alias = join(directory(), "alias");
    symlinkSync(root, alias, "dir");
    expect(await previewCheckout(alias, "Repo")).toEqual({
      path: join(root, "Repo"),
      root,
      state: "missing",
    });
    expect(existsSync(join(root, "Repo"))).toBe(false);
    await expect(previewCheckout(join(root, "missing"), "Repo")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(previewCheckout(`${root}/..`, "Repo")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(previewCheckout("~/../Projects", "Repo")).rejects.toMatchObject({
      code: "invalid_request",
    });
    for (const name of [".", "..", ".GiT", "owner/repo", "owner\\repo", "repo\nother"]) {
      await expect(previewCheckout(root, name)).rejects.toMatchObject({ code: "invalid_request" });
    }
    symlinkSync(repo(), join(root, "symlink"), "dir");
    symlinkSync(join(root, "absent"), join(root, "dangling"));
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "file"), "leave me alone");
    git(root, ["init", "--bare", join(root, "bare")]);
    for (const name of ["symlink", "dangling", "empty", "file", "bare"]) {
      expect((await previewCheckout(root, name)).state).toBe("collision");
    }
  });

  it("reuses a dirty main checkout without mutation and reads literal origin, not a rewrite", async () => {
    const checkout = repo("git@GitHub.com:Other/Fork.git");
    const root = join(checkout, "..");
    const folderName = basename(checkout);
    git(checkout, ["branch", "-m", "trunk"]);
    git(checkout, [
      "config",
      "url.https://github.com/Owner/Repo.git.insteadOf",
      "git@GitHub.com:Other/Fork.git",
    ]);
    writeFileSync(join(checkout, "README.md"), "dirty\n");
    const config = readFileSync(join(checkout, ".git", "config"));
    const preview = await previewCheckout(root, folderName);
    expect(preview).toMatchObject({
      state: "existing",
      checkout: {
        root: checkout,
        repoIdentity: "https://github.com/Other/Fork",
        defaultBranch: "trunk",
      },
    });
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("dirty\n");
    expect(readFileSync(join(checkout, ".git", "config"))).toEqual(config);
    git(checkout, [
      "remote",
      "set-url",
      "origin",
      `https://x-access-token:${TOKEN}@github.com/Owner/Repo.git`,
    ]);
    expectNoGrant(JSON.stringify(await previewCheckout(root, folderName)));
    git(checkout, ["remote", "set-url", "origin", "https://unrelated.example/Owner/Repo.git"]);
    expect((await previewCheckout(root, folderName)).state).toBe("collision");
  });

  it("locates a linked worktree's actual main checkout, but does not reuse the linked worktree or a nested folder", async () => {
    const checkout = repo();
    const root = directory();
    const worktree = join(root, "worktree");
    git(checkout, ["worktree", "add", "-b", "feature", worktree]);
    const cwd = join(worktree, "nested");
    mkdirSync(cwd);
    mkdirSync(join(checkout, "nested"));
    expect(await locateCheckout(cwd)).toEqual({
      checkout: {
        root: checkout,
        commonDir: join(checkout, ".git"),
        repoIdentity: "https://github.com/Owner/Repo",
        defaultBranch: "main",
      },
      worktreePath: worktree,
    });
    expect((await previewCheckout(root, "worktree")).state).toBe("collision");
    expect((await previewCheckout(checkout, "nested")).state).toBe("collision");
    expect(await locateCheckout(join(root, "not-there"))).toBeNull();
    expect(await locateCheckout(root)).toBeNull();
  });
});

describe("confirmed checkout clone", () => {
  it("clones a private repository with ephemeral auth, serializes concurrent requests, and previews completion after a lost receipt", async () => {
    const fixture = await privateRemote();
    const root = repo(); // An ancestor's repo config must not affect the clone either.
    git(root, ["config", "url.file:///rewrite-not-allowed/.insteadOf", "https://github.com/"]);
    const c = command(root);
    const { handler, receipts, observed, logs, db, path, drop } = router();
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "url.ext::ignored.insteadOf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/");
    vi.stubEnv("GIT_DIR", "/not-used");
    drop();
    const [first, second] = await Promise.all([handler.handle("one", c), handler.handle("two", c)]);
    expect(first).toMatchObject({
      ok: true,
      result: {
        root: c.expectedPath,
        repoIdentity: "https://github.com/Owner/Repo",
        defaultBranch: "trunk",
      },
    });
    expect(second).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(receipts).toEqual([]);
    expect(await previewCheckout(root, c.folderName)).toMatchObject({
      state: "existing",
      checkout: { defaultBranch: "trunk" },
    });
    expect(await handler.handle("one", c)).toEqual(first); // Defensive receipt de-duplication, never a second Git call.
    expect(fixture.clones).toHaveLength(1);
    expect(fixture.calls).toContain("/Owner/Repo.git/info/refs");
    expect(fixture.clones[0]?.args).toContain(cloneUrl);
    expectNoGrant(JSON.stringify(fixture.clones[0]?.args));
    expect(fixture.clones[0]?.env.GIT_DIR).toBeUndefined();
    expect(Object.values(fixture.clones[0]?.env ?? {})).toContain(
      `Authorization: ${authorization}`,
    );
    expect(
      Object.values(process.env).some(
        (value) => value?.includes(TOKEN) || value?.includes(authorization),
      ),
    ).toBe(false);
    expectNoGrant(
      JSON.stringify([
        first,
        second,
        logs,
        observed,
        handler.commandLog,
        db.all("SELECT * FROM receipts"),
      ]),
    );
    expectNoGrant(readFileSync(path));
    if (existsSync(`${path}-wal`)) expectNoGrant(readFileSync(`${path}-wal`));
    const config = readFileSync(join(c.expectedPath, ".git", "config"), "utf8");
    expect(config).toContain(`url = ${cloneUrl}`);
    expect(config).not.toContain("provisioning");
    expectNoGrant(config);
    expect(readFileSync(join(c.expectedPath, "README.md"), "utf8")).toBe("# test repo\n");
  });

  it("does not clone when root resolution changed, the path exists, the grant expired, or the URL is unsafe", async () => {
    const root = directory();
    const alias = join(directory(), "alias");
    symlinkSync(root, alias, "dir");
    const c = command(root);
    await expect(provisionCheckout({ ...c, root: directory() })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      provisionCheckout({ ...c, grant: { ...c.grant, expiresAt: new Date(0).toISOString() } }),
    ).rejects.toMatchObject({ code: "conflict" });
    for (const url of [
      cloneUrl.replace("github.com", "github.com.invalid"),
      `${cloneUrl}?q=${TOKEN}`,
      cloneUrl.replace("https://", `https://${TOKEN}@`),
      "https://github.com/Owner/../Repo.git",
      "http://github.com/Owner/Repo.git",
    ]) {
      await expect(provisionCheckout({ ...c, cloneUrl: url })).rejects.toMatchObject({
        code: "invalid_request",
        message: "Expected a canonical GitHub HTTPS clone URL.",
      });
    }
    expect(existsSync(c.expectedPath)).toBe(false);
    mkdirSync(c.expectedPath);
    writeFileSync(join(c.expectedPath, "keep"), "user data");
    await expect(provisionCheckout({ ...c, root: alias })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(readFileSync(join(c.expectedPath, "keep"), "utf8")).toBe("user data");
  });

  it.each(["deny", "redirect", "empty", "stall"] as const)(
    "leaves %s clone failures inspectable without replay or credentials",
    async (mode) => {
      const fixture = await privateRemote(mode);
      const { handler, db, path, logs, receipts } = router();
      const c = command(directory());
      if (mode === "stall") c.grant.expiresAt = new Date(Date.now() + 1_200).toISOString();
      const malformed = await handler.handle("bad", { ...c, grant: { ...c.grant, [TOKEN]: true } });
      expect(malformed).toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: "Invalid checkout command." },
      });
      const failed = await handler.handle("failed", c);
      expect(failed).toMatchObject({ ok: false, error: { details: { partialCheckout: true } } });
      if (mode === "empty")
        expect(failed).toMatchObject({ error: { message: "No default branch to start work on" } });
      if (mode === "stall") expect(failed).toMatchObject({ error: { code: "timeout" } });
      expect(fixture.calls).toEqual(["/Owner/Repo.git/info/refs"]);
      expect((await previewCheckout(c.root, c.folderName)).state).toBe("collision");
      expect(await handler.handle("failed", c)).toEqual(failed);
      expect(fixture.clones).toHaveLength(1);
      expectNoGrant(JSON.stringify([logs, receipts, db.all("SELECT * FROM receipts")]));
      expectNoGrant(readFileSync(path));
      if (existsSync(`${path}-wal`)) expectNoGrant(readFileSync(`${path}-wal`));
      const config = join(c.expectedPath, ".git", "config");
      if (existsSync(config)) expectNoGrant(readFileSync(config));
    },
  );

  it("does not replay an interrupted command or adopt a repository with an incomplete provisioning marker", async () => {
    const { handler, db } = router();
    const checkout = repo();
    const folderName = basename(checkout);
    const root = join(checkout, "..");
    git(checkout, ["config", "--local", "switchyard.provisioning", "true"]);
    const interrupted = "interrupted";
    db.run("INSERT INTO receipts (command_id, json, created_at) VALUES (?, ?, ?)", [
      interrupted,
      JSON.stringify({ commandId: interrupted, pending: true, type: "checkout.provision" }),
      new Date().toISOString(),
    ]);
    expect(handler.recoverPending()).toBe(1);
    expect(await handler.handle(interrupted, command(root, folderName))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Check checkout status") },
    });
    expect(await locateCheckout(checkout)).toBeNull();
    expect((await previewCheckout(root, folderName)).state).toBe("collision");
  });
});
