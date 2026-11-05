// Regenerate the PNG icons from packages/web/public/icon.svg (needs librsvg's rsvg-convert).
// icon.svg must contain <rect id="bg" ... fill="X"/> and <g id="mark">...</g>.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pub = new URL("../packages/web/public/", import.meta.url).pathname;
const svg = readFileSync(join(pub, "icon.svg"), "utf8");
const bg = svg.match(/<rect id="bg"[^>]*\sfill="([^"]+)"/);
const start = svg.indexOf('<g id="mark"');
if (!bg || start < 0) {
  console.error('icon.svg needs <rect id="bg" fill=...> and <g id="mark">');
  process.exit(1);
}
const mark = svg.slice(start, svg.lastIndexOf("</g>") + 4);
const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${bg[1]}"/>${body}</svg>`;
const dir = mkdtempSync(join(tmpdir(), "icons-"));
const full = join(dir, "full.svg");
const maskable = join(dir, "maskable.svg");
writeFileSync(full, wrap(mark));
writeFileSync(maskable, wrap(`<g transform="translate(51.2 51.2) scale(0.8)">${mark}</g>`));

const render = (input, size, out) => {
  try {
    execFileSync("rsvg-convert", [
      "-w",
      String(size),
      "-h",
      String(size),
      input,
      "-o",
      join(pub, out),
    ]);
  } catch (e) {
    if (e.code === "ENOENT") console.error("Install librsvg (brew install librsvg)");
    else console.error(String(e.message));
    process.exit(1);
  }
};
render(join(pub, "icon.svg"), 192, "icon-192.png");
render(join(pub, "icon.svg"), 512, "icon-512.png");
render(full, 180, "apple-touch-icon.png");
render(maskable, 512, "maskable-512.png");
rmSync(dir, { recursive: true, force: true });
console.log("Wrote icon-192, icon-512, apple-touch-icon and maskable-512 PNGs");
