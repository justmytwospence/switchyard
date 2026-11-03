import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  <string>{{LABEL}}</string>
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
    <string>--state-dir</string>
    <string>{{STATE_DIR}}</string>
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
  <!-- Interactive, not Background: the Pi sessions it starts inherit the job's scheduling, and
       macOS throttles Background jobs' CPU, I/O and timers (prompts took seconds to start). -->
  <key>ProcessType</key>
  <string>Interactive</string>
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
ExecStart="{{NODE}}" "{{CLI}}" host run --config "{{CONFIG}}" --state-dir "{{STATE_DIR}}"
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
  stateDir: string;
  /** launchd label (ignored by the systemd template). */
  label: string;
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
    if (k !== "path" && k !== "label" && !v.startsWith("/")) {
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
    .replaceAll("{{LABEL}}", esc(vars.label))
    .replaceAll("{{CONFIG}}", esc(vars.config))
    .replaceAll("{{STATE_DIR}}", esc(vars.stateDir))
    .replaceAll("{{HOME}}", kind === "launchd" ? esc(vars.home) : vars.home)
    .replaceAll("{{PATH}}", kind === "launchd" ? esc(vars.path) : systemdEscape(vars.path, false))
    .replaceAll("{{LOG_DIR}}", esc(vars.logDir));
}

export function serviceKindFor(platform: NodeJS.Platform): ServiceKind {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new CliError(`Service install is supported on macOS and Linux, not ${platform}`);
}

/** launchd label and systemd unit for the default agent or a named second instance. */
export function serviceNames(instance?: string): { label: string; unit: string } {
  if (instance === undefined) return { label: LAUNCHD_LABEL, unit: SYSTEMD_UNIT };
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
    throw new CliError("Instance names use lowercase letters, digits and dashes (at most 32)");
  }
  return { label: `${LAUNCHD_LABEL}.${instance}`, unit: `switchyard-host-${instance}.service` };
}

export function serviceFilePath(kind: ServiceKind, home = homedir(), instance?: string): string {
  const { label, unit } = serviceNames(instance);
  return kind === "launchd"
    ? join(home, "Library", "LaunchAgents", `${label}.plist`)
    : join(home, ".config", "systemd", "user", unit);
}

/** Commands that load the service (and restart it when it is already loaded). */
export function loadCommands(
  kind: ServiceKind,
  file: string,
  uid: number,
  instance?: string,
): string[][] {
  const { label, unit } = serviceNames(instance);
  return kind === "launchd"
    ? [
        ["launchctl", "bootout", `gui/${uid}/${label}`],
        ["launchctl", "bootstrap", `gui/${uid}`, file],
      ]
    : [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", unit],
        ["systemctl", "--user", "restart", unit],
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
  /** A second agent beside the default one (e.g. "dev"); needs `config` and `stateDir`. */
  instance?: string;
  stateDir?: string;
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
  const names = serviceNames(flags.instance);
  if (flags.instance !== undefined && !(flags.config && flags.stateDir)) {
    throw new CliError(
      "--instance needs --config and --state-dir, so the second host agent keeps its own enrollment and state",
    );
  }
  const config = flags.config ?? defaultConfigPath(ctx.env, deps.home);
  if (!existsSync(config) && !flags.print) {
    throw new CliError(
      `No host config at ${config}. Enroll first: switchyard host enroll --coordinator <url> --token <t>`,
    );
  }
  const stateDir = flags.stateDir
    ? resolve(flags.stateDir)
    : defaultStateDir(ctx.env, deps.platform, deps.home);
  const logDir = join(stateDir, "logs");
  const content = renderService(
    kind,
    {
      node: stableNodePath(process.execPath),
      cli: cliEntry(),
      config,
      stateDir,
      label: names.label,
      home: deps.home,
      path: ctx.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      logDir,
    },
    loadTemplate(kind),
  );
  const file = serviceFilePath(kind, deps.home, flags.instance);
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
    for (const c of loadCommands(kind, file, deps.uid, flags.instance).slice(1))
      ctx.out(`  ${c.join(" ")}`);
    return { file, content };
  }
  for (const cmd of loadCommands(kind, file, deps.uid, flags.instance)) {
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
    `The host agent runs as ${kind === "launchd" ? names.label : names.unit}; logs: ${logDir}`,
  );
  return { file, content };
}
