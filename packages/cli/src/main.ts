#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SwitchyardError } from "@switchyard/protocol";
import { ApiRequestError } from "@switchyard/terminal";
import { Command, Option } from "commander";
import { login, pair } from "./commands/auth.js";
import {
  coordinatorBackup,
  coordinatorMigrate,
  coordinatorRestore,
  coordinatorStart,
} from "./commands/coordinator.js";
import { defaultDoctorDeps, printDoctor, runDoctor } from "./commands/doctor.js";
import { herdrDaemon, herdrNew, herdrPair, herdrPane, herdrStatus } from "./commands/herdr.js";
import { hostBackup, hostEnroll, hostRun, hostStatus } from "./commands/host.js";
import { hostsFolders, hostsList, hostsScan } from "./commands/hosts.js";
import { installService } from "./commands/service.js";
import { tuiCommand } from "./commands/tui.js";
import { up } from "./commands/up.js";
import { viewsCreate, viewsDelete, viewsEdit, viewsList, viewsPin } from "./commands/views.js";
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
import { type Ctx, defaultCtx } from "./context.js";

export const CLI_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

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
  return { coordinator: o.coordinator, credential: o.credential, dataDir: o.dataDir };
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
    })
    // Subcommands copy this at creation, so it must come before any `.command(...)`.
    .exitOverride();

  program
    .command("up")
    .description("Run a standalone coordinator and a local host agent in this process")
    .option("--port <port>", "port", "7400")
    .option("--bind <addr>", "address to listen on (default 0.0.0.0)")
    .addOption(new Option("--host <addr>", "deprecated: use --bind").hideHelp())
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
    .option("--token <token>", "host enrollment token (switchyard pair host)")
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
    .option("--state-dir <dir>", "state dir (default: the platform default)")
    .option(
      "--instance <name>",
      "run a second host agent beside the default one, e.g. dev; needs --config and --state-dir",
    )
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
    .option(
      "--instance <name>",
      "a second host agent (install-service --instance); needs --config and --state-dir",
    )
    .option("--json", "JSON output")
    .action((o) => hostStatus(ctx, o));

  const pairCmd = program
    .command("pair")
    .description(
      "Print a single-use sign-in link and QR for a browser, using the admin token: for local servers and recovery",
    )
    .addOption(new Option("--host").hideHelp())
    .option("--coordinator <url>", "local coordinator URL (default: the running one)")
    .option("--data-dir <dir>", "data dir holding admin.token")
    .option("--json", "JSON output")
    .action(async (o) => {
      if (o.host) ctx.err("switchyard: `pair --host` is deprecated; use `switchyard pair host`");
      await pair(ctx, { ...o, host: o.host === true });
    });
  pairCmd
    .command("host")
    .description("Print a single-use host enrollment token and the command to run on the new host")
    .option("--coordinator <url>", "local coordinator URL (default: the running one)")
    .option("--data-dir <dir>", "data dir holding admin.token")
    .option("--json", "JSON output")
    .action(async (_o, cmd: Command) => {
      // `pair` parses its own options even after `host`: read both levels.
      await pair(ctx, { ...cmd.optsWithGlobals(), host: true });
    });

  program
    .command("login")
    .description(
      "Sign this terminal in by approving it in a browser (writes ~/.config/switchyard/client.json)",
    )
    .option("--coordinator <url>", "coordinator URL (default: SWITCHYARD_URL or client.json)")
    .option("--name <name>", "device name")
    .option(
      "--token <token>",
      "single-use sign-in link or token from `switchyard pair`, instead of browser approval",
    )
    .option(
      "--open",
      "open the approval page in a browser (default: when interactive and not over SSH)",
    )
    .option("--no-open", "never open a browser")
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
    if (code !== 0) throw new CliError("doctor found failures", code, true);
  });

  const hosts = program.command("hosts").description("Hosts and their project folders");
  connectionOptions(hosts.command("list").description("List hosts"))
    .option("--json", "JSON output")
    .action((o) => hostsList(ctx, { ...connFlags(o), json: o.json }));
  connectionOptions(
    hosts
      .command("folders <host>")
      .description(
        "Show or change a host's project folders (absolute or ~/... on the host; quote ~ so your shell does not expand it)",
      ),
  )
    .option("--set <folder...>", "replace the folders")
    .option("--add <folder...>", "add folders")
    .option("--remove <folder...>", "remove folders")
    .option("--clear", "remove every folder")
    .option("--json", "JSON output")
    .action(async (ref, o) => {
      await hostsFolders(ctx, ref, {
        ...connFlags(o),
        set: o.set,
        add: o.add,
        remove: o.remove,
        clear: o.clear,
        json: o.json,
      });
    });
  connectionOptions(
    hosts
      .command("scan <host>")
      .description("Scan a host's project folders now and add new repositories as projects"),
  )
    .option("--json", "JSON output")
    .action(async (ref, o) => {
      await hostsScan(ctx, ref, { ...connFlags(o), json: o.json });
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
    .option("--host <host>", "host id or name holding the file (default: the only host)")
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
      .command("tui <sessionId>")
      .description("Open a session's Pi terminal (Ctrl+] detaches; the session keeps running)"),
  ).action(async (sessionId, o) => {
    await tuiCommand(ctx, sessionId, connFlags(o));
  });

  const herdr = program
    .command("herdr")
    .description("herdr integration: mirror Switchyard into a paired herdr session");
  connectionOptions(
    herdr.command("daemon").description("Mirror Switchyard into this herdr session"),
  )
    .option("--ensure", "start the daemon in the background unless it runs")
    .option("--once", "sync once and print what changed")
    .action(async (o) => {
      await herdrDaemon(ctx, { ...connFlags(o), ensure: o.ensure, once: o.once });
    });
  connectionOptions(
    herdr.command("pane <sessionId>").description("Show a session in this herdr pane"),
  ).action(async (sessionId, o) => {
    await herdrPane(ctx, sessionId, connFlags(o));
  });
  connectionOptions(herdr.command("new").description("Start a session from this herdr tab"))
    .option("--workspace <id>", "the Switchyard workspace of this tab's space")
    .option("--here", "open a new tab in the focused space and start there")
    .action(async (o) => {
      await herdrNew(ctx, { ...connFlags(o), workspace: o.workspace, here: o.here });
    });
  connectionOptions(
    herdr.command("status").description("Which herdr tab shows which session"),
  ).action(async (o) => {
    await herdrStatus(ctx, connFlags(o));
  });

  herdr
    .command("pair")
    .description("Pair a herdr session (default: the unnamed one) with Switchyard")
    .option("--session <name>", "herdr session name (default: default)")
    .option("--view <name>", "view to mirror (default: every session)")
    .option("--cli <command>", "how to run switchyard")
    .option("--client-config <path>", "client.json to use")
    .option("--force", "replace an existing pairing")
    .action(async (o) => {
      await herdrPair(ctx, {
        session: o.session,
        view: o.view,
        cli: o.cli,
        clientConfig: o.clientConfig,
        force: o.force,
      });
    });

  const views = program
    .command("views")
    .description("Views: named session filters for TUI clients");
  const collect = (v: string, prev: string[] = []) => [...prev, v];
  connectionOptions(views.command("list").description("List views"))
    .option("--json", "JSON output")
    .action((o) => viewsList(ctx, { ...connFlags(o), json: o.json }));
  connectionOptions(views.command("create <name>").description("Create a view"))
    .option("--mode <mode>", "all (matching or pinned) or pinned (pinned only)")
    .option("--project <project>", "limit to a project (repeatable)", collect)
    .option("--host <host>", "limit to a host (repeatable)", collect)
    .action((name, o) =>
      viewsCreate(ctx, name, { ...connFlags(o), mode: o.mode, project: o.project, host: o.host }),
    );
  connectionOptions(views.command("edit <view>").description("Change a view"))
    .option("--name <name>", "new name")
    .option("--mode <mode>", "all or pinned")
    .option("--project <project>", "limit to a project (repeatable)", collect)
    .option("--host <host>", "limit to a host (repeatable)", collect)
    .option("--any-project", "remove the project limit")
    .option("--any-host", "remove the host limit")
    .action((ref, o) =>
      viewsEdit(ctx, ref, {
        ...connFlags(o),
        name: o.name,
        mode: o.mode,
        project: o.project,
        host: o.host,
        anyProject: o.anyProject,
        anyHost: o.anyHost,
      }),
    );
  connectionOptions(views.command("delete <view>").description("Delete a view")).action((ref, o) =>
    viewsDelete(ctx, ref, connFlags(o)),
  );
  connectionOptions(views.command("pin <view> <sessionId>").description("Pin a session")).action(
    (ref, id, o) => viewsPin(ctx, ref, id, connFlags(o)),
  );
  connectionOptions(
    views.command("unpin <view> <sessionId>").description("Unpin a session"),
  ).action((ref, id, o) => viewsPin(ctx, ref, id, connFlags(o), true));

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

/** Print a command's error (unless it is silent) and return the process exit code. */
export function reportError(ctx: Ctx, err: unknown): number {
  const e = err as { code?: string; exitCode?: number };
  if (typeof e.code === "string" && e.code.startsWith("commander.")) {
    return e.exitCode ?? 1;
  }
  const { message, code } = describeError(err);
  if (!(err instanceof CliError && err.silent)) ctx.err(`switchyard: ${message}`);
  return code;
}

export async function main(
  argv: string[] = process.argv,
  ctx: Ctx = defaultCtx(),
): Promise<number> {
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    return reportError(ctx, err);
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
