/** Release facts read from the repository at build time, so the site never hand-types them. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB, REPO_ROOT } from "./docs-sources";

const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const buildNpm = readFileSync(join(REPO_ROOT, "scripts", "build-npm.mjs"), "utf8");
const npmName = /const NAME = "([^"]+)"/.exec(buildNpm)?.[1];
if (!npmName) throw new Error("scripts/build-npm.mjs no longer declares NAME");

export const VERSION: string = rootPackage.version;
export const NODE: string = String(rootPackage.engines?.node ?? ">=24").replace(">=", "");
export const NPM_NAME = npmName;
export const INSTALL = `npm install -g ${npmName}`;
export const NPM_URL = `https://www.npmjs.com/package/${npmName}`;
export { GITHUB };
