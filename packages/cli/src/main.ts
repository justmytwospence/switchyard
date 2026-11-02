#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SwitchyardError } from "@switchyard/protocol";
import { ApiRequestError, runTerminal } from "@switchyard/terminal";
import { Command, Option } from "commander";
import { init, login, pair } from "./commands/auth.js";
import {
  coordinatorBackup,
  coordinatorMigrate,
  coordinatorRestore,
  coordinatorStart,
} from "./commands/coordinator.js";
import { defaultDoctorDeps, printDoctor, runDoctor } from "./commands/doctor.js";
import { hostBackup, hostEnroll, hostRun, hostStatus } from "./commands/host.js";
import { installService } from "./commands/service.js";
import { up } from "./commands/up.js";
import {
  automationsList,
  automationsRun,
  sessionsImport,
  sessionsList,
  tasksCreate,
  tasksList,
  tasksMove,
} from "./commands/work.js";
import { CliError } from "./config.js";
import { type Ctx, connect, defaultCtx } from "./context.js";

export const CLI_VERSION = "0.1.0";

/** Turn any thrown error into a message and exit code. */
export function describeError(err: unknown): { message: string; code: number } {
  if (err instanceof CliError) return { message: err.message, code: err.exitCode };
  if (err instanceof ApiRequestError) {
    return { message: `${err.message}${err.code && err.status ? ` (${err.code})` : ""}`, code: 1 };
  }
  if (err instanceof SwitchyardError) return { message: `${err.message} (${err.code})`, code: 1 };
  return { message: err instanceof Error ? err.message : String(err), code: 1 };
}

function connectionOptions(cmd: Command): Command {
  return cmd
    .option("--coordinator <url>", "coordinator URL (default: from `switchyard login`)")
    .option("--credential <credential>", "device credential (default: from `switchyard login`)")
    .option("--data-dir <dir>", "data dir holding admin.token, for local admin access");
}

function connFlags(o: { coordinator?: string; credential?: string; dataDir?: string }) {
  return { coordinator: o.coordinator, token: o.credential, dataDir: o.dataDir };
}

/** Build the `switchyard` program. `ctx` is injectable for tests. */
export function buildProgram(ctx: Ctx = defaultCtx()): Command {
  const program = new Command("switchyard")
    .description("Switchyard: self-hosted metaharness for Pi coding agents")
    .version(CLI_VERSION)
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => ctx.out(s.replace(/\n$/, "")),
      writeErr: (s) => ctx.err(s.replace(/\n$/, "")),
    });

  program
    .command("up")
    .description("Run a standalone coordinator and a local host agent in this process")
    .option("--port <port>", "port", "7400")
    .option("--host <addr>", "bind address", "0.0.0.0")
    .option("--data-dir <dir>", "data dir (default: SWITCHYARD_DATA_DIR or the platform default)")
    .option("--public-url <url>", "URL clients use (default: http://localhost:<port>)")
    .option("--trusted-origins <list>", "comma-separated browser origins to trust")
    .option(
      "--web-dist <dir>",
      "web app bundle to serve (default: SWITCHYARD_WEB_DIST or packages/web/dist)",
    )
    .option("--name <name>", "name of the local host (first start only)")
    .option("--dev", "development: trust the Vite dev server origins, debug logs")
    .option("--open", "open the first sign-in link in a browser (default: when interactive)")
    .option("--no-open", "never open a browser")
    .action((o) => up(ctx, o));

  const coordinator = program.command("coordinator").description("Hub coordinator");
  coordinator
    .command("start")
    .description("Run the coordinator (hub mode)")
    .option("--data-dir <dir>", "data dir (env SWITCHYARD_DATA_DIR)")
    .option("--listen <host:port>", "listen address (env SWITCHYARD_LISTEN, default 0.0.0.0:7400)")
    .option("--public-url <url>", "public URL (env SWITCHYARD_PUBLIC_URL)")
    .option("--trusted-origins <list>", "comma-separated origins (env SWITCHYARD_TRUSTED_ORIGINS)")
    .option("--web-dist <dir>", "web app bundle (env SWITCHYARD_WEB_DIST)")
    .action((o) => coordinatorStart(ctx, o));
  coordinator
    .command("backup <out>")
    .description("Consistent online backup of the coordinator database (VACUUM INTO)")
    .option("--data-dir <dir>", "data dir (env SWITCHYARD_DATA_DIR)")
    .action((out, o) => coordinatorBackup(ctx, out, o));
  coordinator
    .command("restore <file>")
    .description("Restore a backup (the coordinator must be stopped)")
    .option("--data-dir <dir>", "data dir (env SWITCHYARD_DATA_DIR)")
    .action((file, o) => coordinatorRestore(ctx, file, o));
  coordinator
    .command("migrate")
    .description("Apply pending database migrations without starting")
    .option("--data-dir <dir>", "data dir (env SWITCHYARD_DATA_DIR)")
    .action((o) => coordinatorMigrate(ctx, o));

  const host = program.command("host").description("Host agent on this machine");
  host
    .command("enroll")
    .description("Enroll this machine as a host (writes ~/.config/switchyard/host.json)")
    .requiredOption("--coordinator <url>", "coordinator URL")
    .option("--token <token>", "host enrollment token (switchyard pair --host)")
    .option("--secret <secret>", "shared host enrollment secret (SWITCHYARD_HOST_ENROLL_SECRET)")
    .option("--name <name>", "host name (default: hostname)")
    .option("--config <path>", "host.json path")
    .action((o) => hostEnroll(ctx, o));
  host
    .command("run")
    .description("Run the host agent in the foreground (waits for host.json when not enrolled)")
    .option("--config <path>", "host.json path (env SWITCHYARD_HOST_CONFIG)")
    .option("--state-dir <dir>", "state dir (env SWITCHYARD_STATE_DIR)")
    .action((o) => hostRun(ctx, o));
  host
    .command("install-service")
    .description("Install the host agent as a launchd agent (macOS) or systemd user unit (Linux)")
    .option("--config <path>", "host.json path")
    .option("--print", "print the service file without writing it")
    .option("--no-load", "write the file but do not load it")
    .action(async (o) => {
      await installService(ctx, o);
    });
  host
    .command("backup <out>")
    .description("Consistent backup of the host database")
    .option("--state-dir <dir>", "state dir (env SWITCHYARD_STATE_DIR)")
    .action((out, o) => hostBackup(ctx, out, o));
  host
    .command("status")
    .description("Show this host's enrollment, link and Pi status")
    .option("--config <path>", "host.json path")
    .option("--state-dir <dir>", "state dir")
    .option("--json", "JSON output")
    .action((o) => hostStatus(ctx, o));

  program
    .command("init")
    .description("Set up this server and print a single-use sign-in link for your first device")
    .option("--coordinator <url>", "local coordinator URL (default: the running one)")
    .option("--data-dir <dir>", "data dir holding admin.token")
    .option("--json", "JSON output")
    .action(async (o) => {
      await init(ctx, o);
    });

  program
    .command("pair")
    .description(
      "Create a single-use link and QR for another device (or --host); also the recovery path when every device is lost",
    )
    .option("--host", "enroll a host instead of a device")
    .option("--coordinator <url>", "local coordinator URL (default: the running one)")
    .option("--data-dir <dir>", "data dir holding admin.token")
    .option("--json", "JSON output")
    .action(async (o) => {
      await pair(ctx, o);
    });

  program
    .command("login")
    .description("Enroll this terminal as a device (writes ~/.config/switchyard/client.json)")
    .option("--coordinator <url>", "coordinator URL")
    .requiredOption("--token <token>", "device enrollment token or link (switchyard pair)")
    .option("--name <name>", "device name")
    .action(async (o) => {
      await login(ctx, o);
    });

  connectionOptions(
    program
      .command("doctor")
      .description("Check Node, Pi, git, coordinator, credentials, host link and push"),
  ).action(async (o) => {
    const results = await runDoctor(ctx, defaultDoctorDeps(ctx), connFlags(o));
    const code = printDoctor(ctx, results);
    if (code !== 0) throw new CliError("doctor found failures", code);
  });

  const sessions = program.command("sessions").description("Sessions");
  connectionOptions(sessions.command("list").description("List sessions"))
    .option("--project <project>", "project id or name")
    .option("--json", "JSON output")
    .action((o) => sessionsList(ctx, { ...connFlags(o), json: o.json, project: o.project }));
  connectionOptions(
    sessions
      .command("import <sessionFile>")
      .description("Import an inactive Pi session file from a host"),
  )
    .option("--host <hostId>", "host holding the file (default: the only host)")
    .option("--project <project>", "project id or name")
    .option("--json", "JSON output")
    .action(async (file, o) => {
      await sessionsImport(ctx, file, {
        ...connFlags(o),
        host: o.host,
        project: o.project,
        json: o.json,
      });
    });

  connectionOptions(
    program
      .command("attach [sessionId]")
      .description("Open the terminal client (Ctrl+C detaches; sessions keep running)"),
  ).action(async (sessionId, o) => {
    const { conn } = connect(ctx, connFlags(o));
    const result = await runTerminal({
      coordinatorUrl: conn.url,
      credential: conn.credential,
      sessionId,
    });
    if (result.reason === "logout") throw new CliError(`Signed out: ${result.message}`);
  });

  const tasks = program.command("tasks").description("Tasks");
  connectionOptions(tasks.command("create").description("Create a task"))
    .requiredOption("--project <project>", "project id or name")
    .requiredOption("--title <title>", "title")
    .option("--objective <text>", "objective", "")
    .option("--criteria <criterion...>", "acceptance criteria (repeatable)")
    .option("--priority <priority>", "0-3 or Urgent, High, Normal, Low")
    .option("--ready", "create in Ready (authorizes automatic dispatch)")
    .option("--json", "JSON output")
    .action(async (o) => {
      await tasksCreate(ctx, { ...o, ...connFlags(o) });
    });
  connectionOptions(tasks.command("list").description("List tasks"))
    .option(
      "--state <states>",
      "comma-separated states (backlog,ready,in_progress,review,done,canceled)",
    )
    .option("--project <project>", "project id or name")
    .option("--all", "include routine tasks hidden from the board")
    .option("--json", "JSON output")
    .action((o) => tasksList(ctx, { ...o, ...connFlags(o) }));
  connectionOptions(tasks.command("move <taskId> <state>").description("Move a task to a state"))
    .option("--confirm", "confirm moves that need it (e.g. Done without passing checks)")
    .addOption(
      new Option(
        "--on-running <choice>",
        "for a running task: pause automation or stop execution",
      ).choices(["pause", "stop"]),
    )
    .option("--json", "JSON output")
    .action(async (id, state, o) => {
      await tasksMove(ctx, id, state, { ...o, ...connFlags(o) });
    });

  const automations = program.command("automations").description("Automations");
  connectionOptions(automations.command("list").description("List automations"))
    .option("--json", "JSON output")
    .action((o) => automationsList(ctx, { ...connFlags(o), json: o.json }));
  connectionOptions(automations.command("run <automationId>").description("Fire an automation now"))
    .option("--json", "JSON output")
    .action((id, o) => automationsRun(ctx, id, { ...connFlags(o), json: o.json }));

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const ctx = defaultCtx();
  const program = buildProgram(ctx);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    const e = err as { code?: string; exitCode?: number };
    if (typeof e.code === "string" && e.code.startsWith("commander.")) {
      return e.exitCode ?? 1;
    }
    const { message, code } = describeError(err);
    if (!(err instanceof CliError && message === "doctor found failures")) {
      ctx.err(`switchyard: ${message}`);
    }
    return code;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`switchyard: ${describeError(err).message}\n`);
      process.exit(1);
    },
  );
}
