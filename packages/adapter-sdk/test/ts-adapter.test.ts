import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterRegistry, loadAdapterFromDir } from "../src/index.js";
import { manifest, sink, tmp } from "./helpers.js";

/**
 * Adapters shipped inside Pi packages (pi-plugins) are TypeScript loaded with Node's built-in type
 * stripping: erasable syntax only (type annotations, interfaces, `import type`), no runtime
 * imports.
 */
const TYPES_SOURCE = `export interface UINode {
  t: string;
  text?: string;
}
`;

const ADAPTER_SOURCE = `import type { UINode } from "./types.ts";

interface ToolInfo {
  toolCallId: string;
  name: string;
  args: unknown;
}

type Ctx = { adapterId: string };

const card = (text: string): UINode => ({ t: "text", text });

export default {
  toolCard(tool: ToolInfo, _ctx: Ctx): UINode | undefined {
    if (tool.name !== "hello") return undefined;
    const who = (tool.args as { name?: string } | null)?.name ?? "world";
    return card(\`hello \${who}\`);
  },
};
`;

function writeTsAdapter(): string {
  const dir = join(tmp("sy-ts-adapter-"), "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "switchyard-adapter.json"),
    JSON.stringify(manifest("hello", { server: "adapter.ts", capabilities: ["toolCards"] })),
  );
  writeFileSync(join(dir, "adapter.ts"), ADAPTER_SOURCE);
  writeFileSync(join(dir, "types.ts"), TYPES_SOURCE);
  return dir;
}

describe("TypeScript adapters", () => {
  it("load through loadAdapterFromDir and run their hooks", async () => {
    const dir = writeTsAdapter();
    const { adapter, warnings } = await loadAdapterFromDir(dir, "plugin");
    expect(warnings).toEqual([]);
    expect(adapter.manifest).toEqual(
      manifest("hello", { server: "adapter.ts", capabilities: ["toolCards"] }),
    );
    expect(adapter.tier).toBe("plugin");
    expect(typeof adapter.server.toolCard).toBe("function");

    const registry = new AdapterRegistry();
    registry.setAdapters([adapter]);
    const session = registry.openSession({ sessionId: "ses_ts", emit: sink().emit });
    expect(
      await session.toolCard({ toolCallId: "c1", name: "hello", args: { name: "Pi" } }),
    ).toEqual({ adapterId: "hello", node: { t: "text", text: "hello Pi" } });
  });

  it("load under plain Node (type stripping) from the built package", () => {
    const dir = writeTsAdapter();
    const sdk = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const script = `
      const { loadAdapterFromDir } = await import(${JSON.stringify(sdk)});
      const { adapter } = await loadAdapterFromDir(${JSON.stringify(dir)}, "plugin");
      const node = adapter.server.toolCard({ toolCallId: "c1", name: "hello", args: {} }, {});
      process.stdout.write(JSON.stringify({ id: adapter.manifest.id, node }));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual({ id: "hello", node: { t: "text", text: "hello world" } });
  });
});
