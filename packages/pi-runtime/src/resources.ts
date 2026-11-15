import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolvePiPackageRoot } from "./importable.js";

const Inventory = z.strictObject({
  status: z.enum(["available", "unavailable"]),
  extensions: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        enabled: z.boolean(),
        source: z.string().min(1).max(4096),
        scope: z.enum(["user", "project"]),
        packageRoot: z.string().min(1).max(4096).nullable(),
      }),
    )
    .max(32768),
  diagnostics: z.array(z.string().max(4096)).max(4096),
});

export type PiResourceInventory = z.infer<typeof Inventory>;

// Fixed ESM program, not project-supplied code. Import the exact installed Pi's public API;
// never load extensions, temporary sources, auth, or a file-backed settings manager.
const HELPER = String.raw`
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const [entry, cwd, trusted] = process.argv.slice(1);
const diagnostics = [];
const badScopes = new Set();
const empty = (status) => ({ status, extensions: [], diagnostics });
const output = (value) => process.stdout.write(JSON.stringify(value));
try {
  const { DefaultPackageManager, SettingsManager } = await import(entry);
  if (typeof DefaultPackageManager !== "function" || typeof SettingsManager?.fromStorage !== "function")
    throw new Error("Installed Pi does not expose the read-only resource resolver API.");
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const projectTrusted = trusted === "true";
  const resourceKeys = ["extensions", "skills", "prompts", "themes"];
  const strings = (value) => Array.isArray(value) && value.every((s) => typeof s === "string");
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const read = (scope, path) => {
    try {
      const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      const value = JSON.parse(raw);
      if (!object(value)) throw new Error("Invalid settings object");
      for (const key of resourceKeys) {
        if (value[key] !== undefined && !strings(value[key])) throw new Error("Invalid resource array");
      }
      if (value.packages !== undefined && (!Array.isArray(value.packages) || !value.packages.every((pkg) =>
        typeof pkg === "string" || (object(pkg) && typeof pkg.source === "string" &&
          (pkg.autoload === undefined || typeof pkg.autoload === "boolean") &&
          resourceKeys.every((key) => pkg[key] === undefined || strings(pkg[key]))))))
        throw new Error("Invalid packages array");
      // Preserve Pi's own package-manager configuration and merge semantics in memory.
      // Nothing from these settings is returned to the host except resolved provenance.
      return raw;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      badScopes.add(scope);
      diagnostics.push("Cannot read " + scope + " Pi resource settings; that scope is excluded.");
      return undefined;
    }
  };
  const data = {
    global: read("user", join(agentDir, "settings.json")),
    project: projectTrusted ? read("project", join(cwd, ".pi", "settings.json")) : undefined,
  };
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, fn) { data[scope] = fn(data[scope]); },
  }, { projectTrusted: projectTrusted && !badScopes.has("project") });
  if (typeof settingsManager.isProjectTrusted !== "function" ||
      settingsManager.isProjectTrusted() !== (projectTrusted && !badScopes.has("project")))
    throw new Error("Installed Pi does not support trust-aware resource resolution.");
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await manager.resolve(async () => "skip");
  if (!Array.isArray(resolved?.extensions)) throw new Error("Invalid installed Pi resolver result.");
  const extensions = [];
  for (const resource of resolved.extensions) {
    const metadata = resource.metadata;
    if (!metadata || !["user", "project"].includes(metadata.scope))
      throw new Error("Invalid installed Pi resource metadata.");
    if (badScopes.has(metadata.scope) || (metadata.scope === "project" && !projectTrusted)) continue;
    if (typeof resource.path !== "string" || resource.path.startsWith("builtin:")) continue;
    extensions.push({ path: resource.path, enabled: resource.enabled, source: metadata.source,
      scope: metadata.scope, packageRoot: metadata.packageRoot ?? null });
  }
  for (const failure of resolved.installFailures ?? [])
    diagnostics.push("Installed resource unavailable (" + failure.scope + "): " + failure.source);
  if (typeof settingsManager.drainErrors === "function") {
    for (const error of settingsManager.drainErrors())
      diagnostics.push("Pi resource settings error in " + error.scope + " scope.");
  }
  output({ status: "available", extensions, diagnostics });
} catch (error) {
  diagnostics.push(error instanceof Error ? error.message : "Installed Pi resource resolution failed.");
  output(empty("unavailable"));
}
`;

const unavailable = (message: string): PiResourceInventory => ({
  status: "unavailable",
  extensions: [],
  diagnostics: [message],
});

/** Resolve configuration, not loaded code. No install, update, temporary resolution or writes. */
export async function resolveInstalledPiResources(opts: {
  piBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  projectTrusted: boolean;
  extensionsDisabled: boolean;
}): Promise<PiResourceInventory> {
  if (opts.extensionsDisabled) return { status: "available", extensions: [], diagnostics: [] };
  // Match the Pi spawn's cwd/PATH without ever mutating the host's environment.
  const bin = opts.piBin.includes("/")
    ? resolve(opts.cwd, opts.piBin)
    : (opts.env.PATH ?? "/usr/bin:/bin")
        .split(delimiter)
        .map((dir) => resolve(opts.cwd, dir, opts.piBin))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
  const root = bin ? resolvePiPackageRoot(bin) : null;
  if (!root) return unavailable("Cannot locate the installed Pi package for resource resolution.");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        HELPER,
        pathToFileURL(join(root, "dist", "index.js")).href,
        opts.cwd,
        String(opts.projectTrusted),
      ],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          resolve(
            unavailable(
              error.killed
                ? "Installed Pi resource resolver timed out or exceeded its output limit."
                : "Installed Pi resource resolver could not run.",
            ),
          );
          return;
        }
        try {
          const result = Inventory.parse(JSON.parse(stdout));
          if (!opts.projectTrusted && result.extensions.some((entry) => entry.scope === "project"))
            throw new Error("Untrusted project result");
          if (result.status === "unavailable") result.extensions = [];
          resolve(result);
        } catch {
          resolve(unavailable("Installed Pi resource resolver returned malformed output."));
        }
      },
    );
  });
}
