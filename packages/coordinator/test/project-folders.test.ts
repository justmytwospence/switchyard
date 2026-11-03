import type { HostCommand } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeProjectFolders, uniqueProjectName } from "../src/project-folders.js";
import {
  type CommandHandler,
  enrollHost,
  FakeHost,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

let t: TestCoordinator | undefined;
let host: FakeHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  await t?.cleanup();
  t = undefined;
});

function repo(name: string, root: string, repoIdentity: string) {
  return { name, root, commonDir: `${root}/.git`, repoIdentity, defaultBranch: "main" };
}

const handler: CommandHandler = (cmd: HostCommand) => {
  switch (cmd.type) {
    case "checkout.inspect":
      return repo("app", "/repos/app", "https://github.com/me/app");
    case "workspace.discover":
      return [];
    case "projects.scan":
      if (cmd.folder === "/p") {
        return {
          folder: "/p",
          repositories: [
            repo("app", "/p/app", "https://github.com/me/app"),
            repo("App", "/p/App", "https://github.com/me/other"),
            repo("lib", "/p/lib", "local:lib"),
          ],
        };
      }
      if (cmd.folder === "/q") {
        return { folder: "/q", repositories: [repo("tool", "/q/tool", "local:tool")] };
      }
      return {
        __error: { code: "not_found", message: `${cmd.folder} does not exist on this host` },
      };
    default:
      return null;
  }
};

async function setup(h: CommandHandler = handler) {
  t = await startCoordinator({ projectScanIntervalMs: 0 });
  const creds = await enrollHost(t);
  host = await FakeHost.connect(t, creds, h);
  const p = await t.admin("POST", "/api/projects", {
    name: "App",
    hostId: creds.hostId,
    path: "/repos/app",
  });
  expect(p.status).toBe(201);
  return { creds, project: p.body };
}

async function poll(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("poll timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function scanState(hostId: string) {
  return (await t!.admin("GET", `/api/hosts/${hostId}`)).body.projectScan;
}

async function projects() {
  return (await t!.admin("GET", "/api/projects")).body as { id: string; name: string }[];
}

describe("helpers", () => {
  it("normalizes folders and makes names unique", () => {
    expect(
      normalizeProjectFolders(["~/Projects/", " ~/Projects", "/srv/x", "/", "~/", ""]),
    ).toEqual(["~/Projects", "/srv/x", "/", "~"]);
    expect(uniqueProjectName(["a"], "b", "NUC")).toBe("b");
    expect(uniqueProjectName(["A"], "a", "NUC")).toBe("a (NUC)");
    expect(uniqueProjectName(["a", "a (NUC)"], "a", "NUC")).toBe("a (NUC) 2");
  });
});

describe("project folders", () => {
  it("validates and normalizes folders", async () => {
    const { creds } = await setup();
    const bad = await t!.admin("PATCH", `/api/hosts/${creds.hostId}`, {
      projectFolders: ["rel/path"],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
    await host!.close();
    const ok = await t!.admin("PATCH", `/api/hosts/${creds.hostId}`, {
      projectFolders: ["~/Projects/", "~/Projects", "/srv/x"],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.projectFolders).toEqual(["~/Projects", "/srv/x"]);
  });

  it("scans folders into projects and checkouts, idempotently", async () => {
    const { creds, project } = await setup();
    await host!.close();
    await t!.admin("PATCH", `/api/hosts/${creds.hostId}`, { projectFolders: ["/p", "/q", "/x"] });
    // Connecting with folders and no previous scan starts one; wait for it.
    host = await FakeHost.connect(t!, creds, handler);
    await poll(async () => (await scanState(creds.hostId))?.state === "done");
    const scan = await scanState(creds.hostId);
    expect(scan).toMatchObject({ repositories: 4, checkoutsAdded: 4, projectsCreated: 3 });
    expect(scan.errors).toEqual(["/x: /x does not exist on this host"]);
    expect((await projects()).map((p) => p.name).sort()).toEqual([
      "App",
      "App (fake-host)",
      "lib",
      "tool",
    ]);
    const detail = await t!.admin("GET", `/api/projects/${project.id}`);
    expect(detail.body.checkouts.map((c: { path: string }) => c.path).sort()).toEqual([
      "/p/app",
      "/repos/app",
    ]);

    const again = await t!.admin("POST", `/api/hosts/${creds.hostId}/scan-projects`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      state: "done",
      repositories: 4,
      checkoutsAdded: 0,
      added: [],
    });
    expect(await projects()).toHaveLength(4);
  });

  it("reports hosts too old to scan and offline hosts", async () => {
    const { creds } = await setup((cmd) =>
      cmd.type === "projects.scan"
        ? { __error: { code: "invalid_request", message: "Invalid command: no" } }
        : handler(cmd, ""),
    );
    await host!.close();
    await t!.admin("PATCH", `/api/hosts/${creds.hostId}`, { projectFolders: ["/p"] });
    const offline = await t!.admin("POST", `/api/hosts/${creds.hostId}/scan-projects`);
    expect(offline.body.error.code).toBe("host_unreachable");

    host = await FakeHost.connect(t!, creds, (cmd) =>
      cmd.type === "projects.scan"
        ? { __error: { code: "invalid_request", message: "Invalid command: no" } }
        : null,
    );
    // The connect itself may start a scan: wait for it to settle, then scan explicitly.
    await until(() => host!.commands.some((c) => c.command.type === "projects.scan"));
    const r = await t!.admin("POST", `/api/hosts/${creds.hostId}/scan-projects`);
    expect(r.body.error.code).toBe("unsupported_capability");
    expect(r.body.error.message).toMatch(/cannot scan project folders/);
    const h = await t!.admin("GET", `/api/hosts/${creds.hostId}`);
    expect(h.body.projectScan.state).toBe("failed");
  });

  it("scans after folders are saved and when a host reconnects", async () => {
    const { creds } = await setup();
    await t!.admin("PATCH", `/api/hosts/${creds.hostId}`, { projectFolders: ["/q"] });
    let names: string[] = [];
    for (let i = 0; i < 100 && !names.includes("tool"); i++) {
      names = (await projects()).map((p) => p.name);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(names).toContain("tool");

    const scans = () => host!.commands.filter((c) => c.command.type === "projects.scan").length;
    await host!.close();
    host = await FakeHost.connect(t!, creds, handler);
    await new Promise((r) => setTimeout(r, 100));
    expect(scans()).toBe(0); // scanned less than a minute ago
    await host!.close();
    t!.clock.advance(2 * 60_000);
    host = await FakeHost.connect(t!, creds, handler);
    await until(() => scans() === 1);
  });
});
