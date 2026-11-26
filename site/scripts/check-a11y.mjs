// Runs axe (WCAG 2 A and AA) over every page of the built site in light and dark, and checks the
// pages read without JavaScript. Run after `astro build`; needs Playwright's Chromium.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".json": "application/json",
};
const server = createServer((req, res) => {
  let path = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const pages = walk(dist)
  .filter((f) => f.endsWith("index.html") && !/http-equiv="refresh"/.test(readFileSync(f, "utf8")))
  .map((f) => `/${relative(dist, f).replace(/index\.html$/, "")}`);

const browser = await chromium.launch();
const failures = [];
for (const scheme of ["dark", "light"]) {
  const context = await browser.newContext({ colorScheme: scheme });
  const page = await context.newPage();
  for (const path of pages) {
    await page.goto(origin + path);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    for (const v of result.violations)
      failures.push(
        `${path} (${scheme}): ${v.id}: ${v.help}\n    ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join("\n    ")}`,
      );
  }
  await context.close();
}
// Reading without JavaScript: the landing page and a doc still show their content.
const nojs = await browser.newContext({ javaScriptEnabled: false });
const page = await nojs.newPage();
for (const [path, text] of [
  ["/", "Agents where the code is. You, anywhere."],
  ["/docs/model/", "Three questions"],
]) {
  await page.goto(origin + path);
  if (!(await page.getByRole("heading", { name: text }).first().isVisible()))
    failures.push(`${path}: "${text}" is not visible without JavaScript`);
}
await browser.close();
server.close();

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} accessibility problem(s)`);
  process.exit(1);
}
console.log(`a11y ok: ${pages.length} pages, light and dark, and readable without JavaScript`);
