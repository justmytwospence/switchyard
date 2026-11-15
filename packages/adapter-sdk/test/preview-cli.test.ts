import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdapterPreviewJson } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function run(args: string[]) {
  return spawnSync(process.execPath, ["scripts/preview-adapter.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe("preview CLI (built SDK)", () => {
  it("accepts the documented source-checkout flags, prints only valid JSON, and exits nonzero on an intentional hook failure", () => {
    const success = run([
      "--",
      "--adapter",
      "packages/adapter-examples/src/hello",
      "--fixture",
      "packages/adapter-examples/fixtures/hello.json",
    ]);
    expect(success.error).toBeUndefined();
    expect(success.status, success.stderr).toBe(0);
    const output = parseAdapterPreviewJson(success.stdout.trim());
    expect(output.steps.every((step) => step.ok)).toBe(true);
    expect(output.panels.some((panel) => panel.contribution?.placement === "session.panel")).toBe(
      true,
    );
    expect(output.interactions.at(-1)?.state).toBe("pending");
    expect(success.stderr).toContain("not a sandbox");
    const failure = run([
      "--adapter",
      "packages/adapter-examples/src/hello",
      "--fixture",
      "packages/adapter-examples/fixtures/hello-failure.json",
    ]);
    expect(failure.status).toBe(1);
    const broken = parseAdapterPreviewJson(failure.stdout.trim());
    expect(broken.steps.at(-1)?.ok).toBe(false);
    expect(broken.interactions.at(-1)?.state).toBe("pending");
    expect(broken.interactions.at(-1)?.presentation.t).toBe("form");
    expect(failure.stderr).toContain("generic question");
  });

  it("rejects missing/unknown flags and invalid or oversized fixtures without emitting a fake success result", async () => {
    for (const args of [
      [],
      ["--watch"],
      ["--adapter", "x"],
      ["--adapter", "x", "--adapter", "x", "--fixture", "x"],
    ]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    }
    const dir = await mkdtemp(join(tmpdir(), "preview-cli-"));
    try {
      const fixture = join(dir, "fixture.json");
      for (const content of [
        "not json",
        JSON.stringify({ version: 2, steps: [] }),
        " ".repeat(1024 * 1024 + 1),
      ]) {
        await writeFile(fixture, content);
        const result = run(["--adapter", "/missing", "--fixture", fixture]);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Adapter preview failed");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps trusted adapter stdout chatter on stderr and invokes only the selected adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview-cli-adapter-"));
    try {
      await writeFile(
        join(dir, "switchyard-adapter.json"),
        JSON.stringify({
          id: "noisy",
          version: "1",
          target: { extension: "fictional", versionRange: "*", testedVersions: [] },
          protocolVersion: 1,
          server: "server.mjs",
          webRenderer: null,
          capabilities: [],
        }),
      );
      await writeFile(
        join(dir, "server.mjs"),
        `console.log('trusted adapter import'); process.stdout.write('raw adapter chatter\\n');
        export default {onAction(id, payload, ctx){ console.log('real adapter action'); ctx.setPanel('local',{t:'text',text:payload.text}); }};`,
      );
      const fixture = join(dir, "fixture.json");
      await writeFile(
        fixture,
        JSON.stringify({
          version: 1,
          name: "Noisy",
          steps: [
            { kind: "action", data: { actionId: "local", payload: { text: "actually invoked" } } },
          ],
        }),
      );
      const result = run(["--adapter", dir, "--fixture", fixture]);
      expect(result.status, result.stderr).toBe(0);
      expect(parseAdapterPreviewJson(result.stdout.trim()).panels[0]?.node).toEqual({
        t: "text",
        text: "actually invoked",
      });
      expect(result.stderr).toContain("trusted adapter import");
      expect(result.stderr).toContain("raw adapter chatter");
      expect(result.stderr).toContain("real adapter action");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
