import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installService,
  loadCommands,
  renderService,
  type ServiceVars,
  serviceFilePath,
  serviceKindFor,
  serviceNames,
  stableNodePath,
  TEMPLATE_FILES,
  TEMPLATES,
} from "../src/commands/service.js";
import { deployDir } from "../src/paths.js";
import { testCtx } from "./helpers.js";

const vars: ServiceVars = {
  node: "/opt/homebrew/bin/node",
  cli: "/Users/me/Projects/switchyard/packages/cli/dist/main.js",
  config: "/Users/me/.config/switchyard/host.json",
  stateDir: "/Users/me/Library/Application Support/switchyard",
  label: "com.switchyard.host",
  home: "/Users/me",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
  logDir: "/Users/me/Library/Application Support/switchyard/logs",
};

describe("service files", () => {
  it("built-in templates match deploy/launchd and deploy/systemd", () => {
    for (const kind of ["launchd", "systemd"] as const) {
      const file = readFileSync(join(deployDir(), TEMPLATE_FILES[kind]), "utf8");
      expect(file).toBe(TEMPLATES[kind]);
    }
  });

  it("renders the launchd plist with absolute node and cli paths", () => {
    const plist = renderService("launchd", { ...vars, home: "/Users/me & co" });
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    // Pi sessions inherit the job's scheduling; Background would throttle them.
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(plist).toContain(`<string>${vars.cli}</string>`);
    expect(plist).toContain("<string>host</string>\n    <string>run</string>");
    expect(plist).toContain(`<string>${vars.config}</string>`);
    expect(plist).toContain("<string>/Users/me &amp; co</string>");
    expect(plist).toContain(`<string>${vars.logDir}/host.log</string>`);
    expect(plist).not.toMatch(/\{\{/);
  });

  it("renders the systemd unit with quoted, escaped paths", () => {
    const unit = renderService("systemd", {
      ...vars,
      home: "/home/me",
      config: "/home/me/.config/switchyard/host 100%.json",
      path: "/usr/bin:/bin:$HOME/x",
    });
    expect(unit).toContain(
      `ExecStart="/opt/homebrew/bin/node" "${vars.cli}" host run --config "/home/me/.config/switchyard/host 100%%.json"`,
    );
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin:$HOME/x"');
    expect(unit).toContain("WorkingDirectory=/home/me");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("refuses relative paths", () => {
    expect(() => renderService("systemd", { ...vars, node: "node" })).toThrow(/absolute node/);
  });

  it("places files and load commands per platform", () => {
    expect(serviceKindFor("darwin")).toBe("launchd");
    expect(serviceKindFor("linux")).toBe("systemd");
    expect(() => serviceKindFor("win32")).toThrow();
    expect(serviceFilePath("launchd", "/Users/me")).toBe(
      "/Users/me/Library/LaunchAgents/com.switchyard.host.plist",
    );
    expect(serviceFilePath("systemd", "/home/me")).toBe(
      "/home/me/.config/systemd/user/switchyard-host.service",
    );
    expect(loadCommands("launchd", "/f.plist", 501)).toEqual([
      ["launchctl", "bootout", "gui/501/com.switchyard.host"],
      ["launchctl", "bootstrap", "gui/501", "/f.plist"],
    ]);
    expect(loadCommands("systemd", "/u", 1000)[1]).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "switchyard-host.service",
    ]);
  });

  it("uses a stable Homebrew node path when available", () => {
    expect(
      stableNodePath(
        "/opt/homebrew/Cellar/node/26.13.0_1/bin/node",
        (p) => p === "/opt/homebrew/bin/node",
      ),
    ).toBe("/opt/homebrew/bin/node");
    expect(stableNodePath("/usr/bin/node", () => true)).toBe("/usr/bin/node");
  });

  it("writes the unit and runs the load commands, printing both", async () => {
    const ctx = testCtx(async () => new Response("{}"));
    const home = join(ctx.dir, "home");
    const config = join(home, ".config", "switchyard", "host.json");
    mkdirSync(join(home, ".config", "switchyard"), { recursive: true });
    writeFileSync(config, "{}");
    ctx.env.PATH = "/usr/bin:/bin";
    const ran: string[][] = [];
    const { file } = await installService(
      ctx,
      { config },
      {
        platform: "linux",
        home,
        uid: 1000,
        run: async (cmd) => {
          ran.push(cmd);
          return { ok: true, output: "" };
        },
      },
    );
    expect(file).toBe(join(home, ".config/systemd/user/switchyard-host.service"));
    expect(statSync(file).isFile()).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(`--config "${config}"`);
    expect(ran.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now switchyard-host.service",
      "systemctl --user restart switchyard-host.service",
    ]);
    expect(ctx.lines[0]).toBe(`Wrote ${file}`);
  });

  it("retries a launchd bootstrap that races the previous bootout", async () => {
    const ctx = testCtx(async () => new Response("{}"));
    const home = join(ctx.dir, "home");
    const config = join(home, ".config", "switchyard", "host.json");
    mkdirSync(join(home, ".config", "switchyard"), { recursive: true });
    writeFileSync(config, "{}");
    let bootstraps = 0;
    await installService(
      ctx,
      { config },
      {
        platform: "darwin",
        home,
        uid: 501,
        retryDelayMs: 0,
        run: async (cmd) => {
          if (cmd[1] !== "bootstrap") return { ok: true, output: "" };
          bootstraps++;
          return bootstraps < 3
            ? { ok: false, output: "Bootstrap failed: 5: Input/output error" }
            : { ok: true, output: "" };
        },
      },
    );
    expect(bootstraps).toBe(3);
  });

  it("passes the state dir and names a second instance", async () => {
    const plist = renderService("launchd", { ...vars, label: "com.switchyard.host.dev" });
    expect(plist).toContain("<string>com.switchyard.host.dev</string>");
    expect(plist).toContain(`<string>--state-dir</string>\n    <string>${vars.stateDir}</string>`);
    expect(serviceNames()).toEqual({
      label: "com.switchyard.host",
      unit: "switchyard-host.service",
    });
    expect(serviceNames("dev")).toEqual({
      label: "com.switchyard.host.dev",
      unit: "switchyard-host-dev.service",
    });
    expect(() => serviceNames("Dev!")).toThrow(/Instance names/);
    expect(serviceFilePath("systemd", "/home/me", "dev")).toBe(
      "/home/me/.config/systemd/user/switchyard-host-dev.service",
    );

    const ctx = testCtx(async () => new Response("{}"));
    const home = join(ctx.dir, "home");
    const config = join(home, ".config", "switchyard-dev", "host.json");
    mkdirSync(join(home, ".config", "switchyard-dev"), { recursive: true });
    writeFileSync(config, "{}");
    const deps = {
      platform: "darwin" as const,
      home,
      uid: 501,
      retryDelayMs: 0,
      run: async () => ({ ok: true, output: "" }),
    };
    await expect(installService(ctx, { config, instance: "dev" }, deps)).rejects.toThrow(
      /--instance needs --config and --state-dir/,
    );
    const ran: string[][] = [];
    const stateDir = join(home, "state-dev");
    const { file, content } = await installService(
      ctx,
      { config, instance: "dev", stateDir },
      {
        ...deps,
        run: async (cmd) => {
          ran.push(cmd);
          return { ok: true, output: "" };
        },
      },
    );
    expect(file).toBe(join(home, "Library", "LaunchAgents", "com.switchyard.host.dev.plist"));
    expect(content).toContain(`<string>${stateDir}</string>`);
    expect(content).toContain(`<string>${stateDir}/logs/host.log</string>`);
    expect(ran).toEqual([
      ["launchctl", "bootout", "gui/501/com.switchyard.host.dev"],
      ["launchctl", "bootstrap", "gui/501", file],
    ]);
  });

  it("refuses to install before the host is enrolled", async () => {
    const ctx = testCtx(async () => new Response("{}"));
    await expect(
      installService(
        ctx,
        { config: join(ctx.dir, "missing.json") },
        {
          platform: "darwin",
          home: ctx.dir,
          uid: 501,
          run: async () => ({ ok: true, output: "" }),
        },
      ),
    ).rejects.toThrow(/Enroll first/);
  });
});

describe("entryFor", () => {
  it("points service files at dist/main.js when built from the workspace", async () => {
    const { entryFor } = await import("../src/paths.js");
    expect(entryFor("/r/packages/cli/dist/paths.js", "/r/packages/cli")).toBe(
      "/r/packages/cli/dist/main.js",
    );
  });
  it("points at the bundle itself in the npm package", async () => {
    const { entryFor } = await import("../src/paths.js");
    const bundle = "/opt/lib/node_modules/@spencerboucher/switchyard/dist/switchyard.mjs";
    expect(entryFor(bundle, "/opt/lib/node_modules/@spencerboucher/switchyard")).toBe(bundle);
  });
});
