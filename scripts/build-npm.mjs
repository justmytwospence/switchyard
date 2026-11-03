#!/usr/bin/env node
// Builds the published npm package @justmytwospence/switchyard into dist-npm/:
// the CLI with the @switchyard/* workspace code inlined (esbuild), third-party dependencies left
// as ordinary npm dependencies, the Pi bridge extension next to the bundle, and the web app.
// Run after `pnpm build`.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-npm");
const NAME = "@justmytwospence/switchyard";
const PACKAGES = [
  "cli",
  "coordinator",
  "host-agent",
  "terminal",
  "pi-runtime",
  "adapter-sdk",
  "protocol",
];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const rootPkg = readJson(join(root, "package.json"));

const deps = {};
for (const name of PACKAGES) {
  const pkg = readJson(join(root, "packages", name, "package.json"));
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith("@switchyard/")) continue;
    if (deps[dep] && deps[dep] !== range) {
      throw new Error(`Conflicting ranges for ${dep}: ${deps[dep]} vs ${range} (packages/${name})`);
    }
    deps[dep] = range;
  }
}

const entry = join(root, "packages", "cli", "dist", "main.js");
for (const p of [entry, join(root, "packages", "web", "dist", "index.html")]) {
  if (!existsSync(p)) throw new Error(`${p} is missing: run pnpm build first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist", "bridge"), { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: join(out, "dist", "switchyard.mjs"),
  external: [...Object.keys(deps), ...Object.keys(deps).map((d) => `${d}/*`)],
  banner: { js: "#!/usr/bin/env node" },
  // The entry's own shebang would end up after the banner; esbuild keeps only a leading one.
  logLevel: "warning",
});
const bundle = join(out, "dist", "switchyard.mjs");
const text = readFileSync(bundle, "utf8");
const lines = text.split("\n");
const cleaned = [lines[0], ...lines.slice(1).filter((l) => !l.startsWith("#!"))].join("\n");
writeFileSync(bundle, cleaned);
chmodSync(bundle, 0o755);

cpSync(
  join(root, "packages", "pi-runtime", "dist", "bridge", "switchyard-bridge.js"),
  join(out, "dist", "bridge", "switchyard-bridge.js"),
);
cpSync(join(root, "packages", "web", "dist"), join(out, "web-dist"), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

const pkg = {
  name: NAME,
  version: rootPkg.version,
  description:
    "Self-hosted hub for Pi coding agents: run them on your machines, drive them from your phone, browser or terminal",
  license: "MIT",
  type: "module",
  repository: { type: "git", url: "git+https://github.com/justmytwospence/switchyard.git" },
  homepage: "https://github.com/justmytwospence/switchyard#readme",
  bugs: "https://github.com/justmytwospence/switchyard/issues",
  keywords: ["pi", "coding-agent", "agents", "self-hosted", "pwa"],
  bin: { switchyard: "dist/switchyard.mjs" },
  engines: { node: ">=24" },
  files: ["dist", "web-dist", "README.md", "LICENSE"],
  dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  publishConfig: { access: "public" },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Built ${NAME}@${pkg.version} in ${out} (${Object.keys(deps).length} dependencies)`);
