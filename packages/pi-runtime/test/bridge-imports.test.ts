import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bridgeDir = fileURLToPath(new URL("../src/bridge", import.meta.url));

describe("bridge modules", () => {
  // The npm package copies dist/bridge as-is next to Pi's extension loader: no bundling, so only
  // Node built-ins and sibling modules can be imported.
  it("import only Node built-ins and their siblings", () => {
    const files = readdirSync(bridgeDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const source = readFileSync(join(bridgeDir, f), "utf8");
      for (const m of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        expect(spec.startsWith("node:") || spec.startsWith("./"), `${f} imports ${spec}`).toBe(
          true,
        );
      }
    }
  });
});
