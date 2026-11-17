#!/usr/bin/env node
// Build the Node-only SDK independently of the CLI and its native/web dependencies.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-client-npm");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const entry = join(root, "packages/client/dist/index.js");
if (!existsSync(entry)) throw new Error("Build the workspace first: pnpm build");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist/types/protocol"), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: join(out, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["ws", "ws/*", "zod", "zod/*"],
});
function declarations(name, destination) {
  const source = join(root, `packages/${name}/dist`);
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const target = join(destination, item.name);
    if (item.isDirectory()) {
      mkdirSync(target, { recursive: true });
      declarationsDirectory(join(source, item.name), target);
    } else if (item.name.endsWith(".d.ts")) copyDeclaration(join(source, item.name), target);
  }
}
function declarationsDirectory(source, destination) {
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const target = join(destination, item.name);
    if (item.isDirectory()) {
      mkdirSync(target, { recursive: true });
      declarationsDirectory(join(source, item.name), target);
    } else if (item.name.endsWith(".d.ts")) copyDeclaration(join(source, item.name), target);
  }
}
function copyDeclaration(source, target) {
  let text = readFileSync(source, "utf8");
  const protocolIndex = relative(
    dirname(target),
    join(out, "dist/types/protocol/index.js"),
  ).replaceAll("\\", "/");
  text = text.replaceAll(
    '"@switchyard/protocol"',
    `"${protocolIndex.startsWith(".") ? protocolIndex : `./${protocolIndex}`}"`,
  );
  writeFileSync(target, text);
}
declarations("protocol", join(out, "dist/types/protocol"));
declarations("client", join(out, "dist/types"));
cpSync(join(root, "packages/client/README.md"), join(out, "README.md"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
const clientPkg = readJson(join(root, "packages/client/package.json"));
const protocolPkg = readJson(join(root, "packages/protocol/package.json"));
const pkg = {
  name: "@spencerboucher/switchyard-client",
  version: readJson(join(root, "package.json")).version,
  description: "Node.js REST and WebSocket SDK for Switchyard",
  license: "MIT",
  // npm checks provenance against this.
  repository: { type: "git", url: "git+https://github.com/justmytwospence/switchyard.git" },
  type: "module",
  engines: { node: ">=24" },
  exports: { ".": { types: "./dist/types/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md", "LICENSE"],
  dependencies: { ws: clientPkg.dependencies.ws, zod: protocolPkg.dependencies.zod },
  devDependencies: {
    "@types/ws": clientPkg.devDependencies["@types/ws"],
    "@types/node": readJson(join(root, "package.json")).devDependencies["@types/node"],
  },
  publishConfig: { access: "public" },
};
// Declaration consumers need ws and Node type declarations at install time.
pkg.dependencies["@types/ws"] = pkg.devDependencies["@types/ws"];
pkg.dependencies["@types/node"] = pkg.devDependencies["@types/node"];
delete pkg.devDependencies;
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
function check(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) check(path);
    else if (
      /\.(?:js|ts|json)$/.test(item.name) &&
      /["']workspace:|@switchyard\//.test(readFileSync(path, "utf8"))
    )
      throw new Error(`Private workspace reference in ${path}`);
  }
}
check(out);
console.log(`Built ${pkg.name}@${pkg.version} in ${out}`);
