import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = "switchyard-plugin-development";
const required = [
  "SKILL.md",
  "references/authoring.md",
  "references/verification.md",
  "scripts/check.mjs",
];

function collect(dir, includeExcluded = false) {
  const files = [];
  function visit(path, rel = "", excluded = false) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`${path}: symlinks are not allowed`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        visit(
          resolve(path, entry),
          rel ? `${rel}/${entry}` : entry,
          excluded || entry === ".git" || entry === "node_modules",
        );
      }
    } else if (stat.isFile()) {
      if (!excluded || includeExcluded) files.push(rel);
    } else throw new Error(`${path}: expected a regular file or directory`);
  }
  visit(dir);
  return files.sort((a, b) => a.localeCompare(b));
}

export function validateSkill(skillDir, { lockFile, mirrorDir } = {}) {
  const dir = resolve(skillDir);
  const files = collect(dir);
  for (const file of required)
    if (!files.includes(file)) throw new Error(`${dir}/${file}: required file missing`);
  const skill = readFileSync(resolve(dir, "SKILL.md"), "utf8");
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
  if (!front) throw new Error(`${dir}/SKILL.md: missing frontmatter`);
  const field = (key) =>
    new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m")
      .exec(front[1])?.[1]
      ?.replace(/^(["'])(.*)\1$/, "$2");
  if (field("name") !== name) throw new Error(`${dir}/SKILL.md: invalid name`);
  const description = field("description");
  if (!description || description.length > 1024)
    throw new Error(`${dir}/SKILL.md: invalid description`);
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const content = readFileSync(resolve(dir, file), "utf8");
    const inline = [
      ...content.matchAll(/\]\([ \t]*<?([^\s)>]+)>?(?:[ \t]+["'][^)]*["'])?[ \t]*\)/g),
    ];
    const definitions = [...content.matchAll(/^\s*\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm)];
    for (const match of [...inline, ...definitions]) {
      const link = match[1];
      if (/^https?:\/\//i.test(link) || link.startsWith("#")) continue;
      let target;
      try {
        target = decodeURIComponent(link.split(/[?#]/, 1)[0]);
      } catch {
        throw new Error(`${file}: invalid link ${link}`);
      }
      if (
        !target ||
        isAbsolute(target) ||
        /^[a-z][a-z\d+.-]*:/i.test(target) ||
        target.includes("\\")
      )
        throw new Error(`${file}: invalid link ${link}`);
      const absolute = resolve(dir, dirname(file), target);
      const rel = relative(dir, absolute);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`${file}: escaping link ${link}`);
      try {
        const stat = lstatSync(absolute);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error();
      } catch {
        throw new Error(`${file}: missing link ${link}`);
      }
    }
  }
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update(readFileSync(resolve(dir, file)));
  const hash = digest.digest("hex");
  if (lockFile) {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    if (lock.version !== 1) throw new Error(`${lockFile}: invalid version`);
    const entry = lock.skills?.[name];
    if (!entry) throw new Error(`${lockFile}: missing skill entry ${name}`);
    for (const [key, value] of Object.entries({
      source: "justmytwospence/switchyard",
      sourceType: "github",
      skillPath: `skills/${name}/SKILL.md`,
      computedHash: hash,
    })) {
      if (entry[key] !== value) throw new Error(`${lockFile}: invalid ${key}`);
    }
    if (!/^[a-f0-9]{40}$/.test(entry.ref || "")) throw new Error(`${lockFile}: invalid ref`);
  }
  if (mirrorDir) {
    const mirror = resolve(mirrorDir);
    const sourceFiles = collect(dir, true);
    const mirrorFiles = collect(mirror, true);
    if (JSON.stringify(sourceFiles) !== JSON.stringify(mirrorFiles))
      throw new Error(`${mirror}: file set differs`);
    for (const file of sourceFiles)
      if (!readFileSync(resolve(dir, file)).equals(readFileSync(resolve(mirror, file))))
        throw new Error(`${mirror}/${file}: content differs`);
  }
  return { name, hash, files };
}

function main(args) {
  const usage = "Usage: check.mjs [--lock <path>] [--mirror <directory>]";
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const key = flag === "--lock" ? "lockFile" : flag === "--mirror" ? "mirrorDir" : null;
    if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(usage);
    options[key] = args[++i];
  }
  const result = validateSkill(resolve(dirname(fileURLToPath(import.meta.url)), ".."), options);
  console.log(
    `PASS ${result.name} (bundle${options.lockFile ? ", lock" : ""}${options.mirrorDir ? ", mirror" : ""}; SHA-256 ${result.hash})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
