import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfigPath, defaultStateDir } from "@switchyard/host-agent";
import { CliError } from "../config.js";
import type { Ctx } from "../context.js";
import { cliEntry, deployDir } from "../paths.js";

/**
 * `switchyard host install-service`: render the launchd plist (macOS) or systemd user unit
 * (Linux) from the templates in `deploy/`, write it, and load it. It acts only when the user runs
 * it, and prints every file and command.
 */

export type ServiceKind = "launchd" | "systemd";

export const LAUNCHD_LABEL = "com.switchyard.host";
export const SYSTEMD_UNIT = "switchyard-host.service";

/** Built-in copies of `deploy/launchd/com.switchyard.host.plist` and `deploy/systemd/...`. */
export const TEMPLATES: Record<ServiceKind, string> = {
  launchd: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Switchyard host agent (launchd user agent). Written by \`switchyard host install-service\`. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.switchyard.host</string>
  <key>ProgramArguments</key>
  <!-- Through zsh (every Mac has /bin/zsh) so the agent and the Pi sessions it starts get the
       environment ~/.zshenv sets for a terminal, like provider settings; PATH below is the base. -->
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>exec "$0" "$@"</string>
    <string>{{NODE}}</string>
    <string>{{CLI}}</string>
    <string>host</string>
    <string>run</string>
    <string>--config</string>
    <string>{{CONFIG}}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{{PATH}}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>{{HOME}}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>{{LOG_DIR}}/host.log</string>
  <key>StandardErrorPath</key>
  <string>{{LOG_DIR}}/host.log</string>
</dict>
</plist>
`,
  systemd: `# Switchyard host agent (systemd user unit). Written by \`switchyard host install-service\`.
[Unit]
Description=Switchyard host agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="{{NODE}}" "{{CLI}}" host run --config "{{CONFIG}}"
Environment="PATH={{PATH}}"
WorkingDirectory={{HOME}}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
`,
};

export const TEMPLATE_FILES: Record<ServiceKind, string> = {
  launchd: join("launchd", `${LAUNCHD_LABEL}.plist`),
  systemd: join("systemd", SYSTEMD_UNIT),
};

export interface ServiceVars {
  node: string;
  cli: string;
  config: string;
  home: string;
  path: string;
  logDir: string;
}

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Escape for a double-quoted systemd value; `$` only expands in `Exec*=` lines. */
function systemdEscape(s: string, exec = true): string {
  if (/[\n\r]/.test(s)) throw new CliError("Paths for the systemd unit cannot contain newlines");
  const out = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return exec ? out.replaceAll("$", "$$$$") : out;
}

/** The template from `deploy/` when present (source checkout), else the built-in copy. */
export function loadTemplate(kind: ServiceKind, dir = deployDir()): string {
  const p = join(dir, TEMPLATE_FILES[kind]);
  return existsSync(p) ? readFileSync(p, "utf8") : TEMPLATES[kind];
}

/** Substitute absolute paths into a service template, escaped for its format. */
export function renderService(
  kind: ServiceKind,
  vars: ServiceVars,
  template = TEMPLATES[kind],
): string {
  for (const [k, v] of Object.entries(vars)) {
    if (k !== "path" && !v.startsWith("/")) {
      throw new CliError(`Service file needs an absolute ${k} path, got "${v}"`);
    }
  }
  const esc = kind === "launchd" ? xmlEscape : systemdEscape;
  // WorkingDirectory in a systemd unit is unquoted: refuse characters that would need quoting.
  if (kind === "systemd" && /\s/.test(vars.home)) {
    throw new CliError("The home directory path contains whitespace; edit the unit by hand");
  }
  return template
    .replaceAll("{{NODE}}", esc(vars.node))
    .replaceAll("{{CLI}}", esc(vars.cli))
    .replaceAll("{{CONFIG}}", esc(vars.config))
    .replaceAll("{{HOME}}", kind === "launchd" ? esc(vars.home) : vars.home)
    .replaceAll("{{PATH}}", kind === "launchd" ? esc(vars.path) : systemdEscape(vars.path, false))
    .replaceAll("{{LOG_DIR}}", esc(vars.logDir));
}

export function serviceKindFor(platform: NodeJS.Platform): ServiceKind {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new CliError(`Service install is supported on macOS and Linux, not ${platform}`);
}

export function serviceFilePath(kind: ServiceKind, home = homedir()): string {
  return kind === "launchd"
    ? join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** Commands that load the service (and restart it when it is already loaded). */
export function loadCommands(kind: ServiceKind, file: string, uid: number): string[][] {
  return kind === "launchd"
    ? [
        ["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`],
        ["launchctl", "bootstrap", `gui/${uid}`, file],
      ]
    : [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
        ["systemctl", "--user", "restart", SYSTEMD_UNIT],
      ];
}

/**
 * A Node path that survives upgrades: Homebrew's versioned `Cellar/node/<v>/bin/node` becomes
 * `<prefix>/bin/node` when that exists.
 */
export function stableNodePath(
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const m = execPath.match(/^(.*)\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/);
  if (m) {
    const candidate = `${m[1]}/bin/node`;
    if (exists(candidate)) return candidate;
  }
  return execPath;
}

export interface InstallFlags {
  config?: string;
  print?: boolean;
  load?: boolean;
}

export interface InstallDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  run: (cmd: string[]) => Promise<{ ok: boolean; output: string }>;
  /** Delay between bootstrap retries (tests set 0). */
  retryDelayMs?: number;
}

export function defaultInstallDeps(): InstallDeps {
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    run: (cmd) =>
      new Promise((resolve) =>
        execFile(cmd[0]!, cmd.slice(1), (err, stdout, stderr) =>
          resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }),
        ),
      ),
  };
}

export async function installService(
  ctx: Ctx,
  flags: InstallFlags,
  deps: InstallDeps = defaultInstallDeps(),
): Promise<{ file: string; content: string }> {
  const kind = serviceKindFor(deps.platform);
  const config = flags.config ?? defaultConfigPath(ctx.env, deps.home);
  if (!existsSync(config) && !flags.print) {
    throw new CliError(
      `No host config at ${config}. Enroll first: switchyard host enroll --coordinator <url> --token <t>`,
    );
  }
  const logDir = join(defaultStateDir(ctx.env, deps.platform, deps.home), "logs");
  const content = renderService(
    kind,
    {
      node: stableNodePath(process.execPath),
      cli: cliEntry(),
      config,
      home: deps.home,
      path: ctx.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      logDir,
    },
    loadTemplate(kind),
  );
  const file = serviceFilePath(kind, deps.home);
  if (flags.print) {
    ctx.out(content.trimEnd());
    return { file, content };
  }
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { mode: 0o644 });
  ctx.out(`Wrote ${file}`);
  if (flags.load === false) {
    ctx.out("Not loaded (--no-load). Load it with:");
    for (const c of loadCommands(kind, file, deps.uid).slice(1)) ctx.out(`  ${c.join(" ")}`);
    return { file, content };
  }
  for (const cmd of loadCommands(kind, file, deps.uid)) {
    ctx.out(`$ ${cmd.join(" ")}`);
    let r = await deps.run(cmd);
    // launchd tears a booted-out agent down asynchronously; a bootstrap right after a bootout
    // fails with "5: Input/output error" until it is gone. Retry for a few seconds.
    for (let i = 0; !r.ok && cmd[1] === "bootstrap" && i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 500));
      r = await deps.run(cmd);
    }
    // `bootout` fails when the agent was not loaded yet; that is expected.
    if (!r.ok && cmd[1] !== "bootout") {
      throw new CliError(`${cmd.join(" ")} failed${r.output ? `: ${r.output}` : ""}`);
    }
  }
  ctx.out(
    `The host agent runs as ${kind === "launchd" ? LAUNCHD_LABEL : SYSTEMD_UNIT}; logs: ${logDir}`,
  );
  return { file, content };
}
