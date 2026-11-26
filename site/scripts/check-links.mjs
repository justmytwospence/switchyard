// Checks the built site (dist/): every doc in the repository has a page, and every internal link
// and anchor resolves. External links are not fetched. Run after `astro build`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_SOURCES, REPO_ROOT } from "../src/docs-sources.ts";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const problems = [];

// 1. Every doc is on the site.
const listed = new Set(DOC_SOURCES.map((d) => d.path));
const docs = [
  ...readdirSync(join(REPO_ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  ...readdirSync(join(REPO_ROOT, "integrations")).map((d) => `integrations/${d}/README.md`),
];
for (const doc of docs) {
  if (!listed.has(doc)) problems.push(`${doc} is not in src/docs-sources.ts`);
}

// 2. Internal links and anchors.
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const pages = walk(dist).filter((f) => f.endsWith(".html"));
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
};
const resolveTarget = (url) => {
  const path = decodeURIComponent(url.pathname);
  for (const candidate of [path, join(path, "index.html"), `${path}.html`]) {
    const file = join(dist, candidate);
    try {
      if (statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
};
const redirects = new Set(["/docs", "/docs/"]);
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const from = `/${relative(dist, page)}`;
  // Redirect pages and search index fragments are generated, not authored.
  if (/http-equiv="refresh"/.test(html)) continue;
  const base = new URL(from, "https://site.invalid");
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replaceAll("&amp;", "&");
    if (/^(https?:|mailto:|data:|javascript:)/.test(raw)) continue;
    const url = new URL(raw, base);
    if (url.origin !== base.origin) continue;
    if (redirects.has(url.pathname)) continue;
    const target = url.pathname === base.pathname ? page : resolveTarget(url);
    if (!target) {
      problems.push(`${from}: broken link ${raw}`);
      continue;
    }
    const hash = decodeURIComponent(url.hash.slice(1));
    if (hash && target.endsWith(".html") && !idsOf(target).has(hash))
      problems.push(`${from}: missing anchor ${raw}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} link problem(s)`);
  process.exit(1);
}
console.log(`links ok: ${pages.length} pages, ${docs.length} docs`);
