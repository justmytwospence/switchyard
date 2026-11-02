import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_TIMEOUT_MS, OUTPUT_TAIL_BYTES, runChecks } from "../src/checks.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-checks-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runChecks", () => {
  it("exports its limits", () => {
    expect(CHECK_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(OUTPUT_TAIL_BYTES).toBe(8 * 1024);
  });

  it("runs every command and reports exit codes", async () => {
    const chunks: string[] = [];
    const { results } = await runChecks(dir, ["echo ok; pwd", "echo bad 1>&2; exit 2", "true"], {
      onOutput: (command, chunk) => chunks.push(`${command}|${chunk}`),
    });
    expect(results).toEqual([
      { command: "echo ok; pwd", exitCode: 0, outputTail: `ok\n${dir}\n` },
      { command: "echo bad 1>&2; exit 2", exitCode: 2, outputTail: "bad\n" },
      { command: "true", exitCode: 0, outputTail: "" },
    ]);
    expect(chunks.join("")).toContain("echo bad 1>&2; exit 2|bad");
  });

  it("keeps only the last 8 KB of output", async () => {
    const { results } = await runChecks(dir, [
      "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done",
      // Multibyte output: the cut must land on a character boundary.
      "i=0; while [ $i -lt 2000 ]; do printf 'é€'; i=$((i+1)); done; echo end",
    ]);
    const [ascii, multi] = results;
    expect(Buffer.byteLength(ascii!.outputTail)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(ascii!.outputTail)).toBeGreaterThan(OUTPUT_TAIL_BYTES - 16);
    expect(ascii!.outputTail.endsWith("line-1999\n")).toBe(true);
    expect(Buffer.byteLength(multi!.outputTail)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(multi!.outputTail).not.toContain("\uFFFD");
    expect(multi!.outputTail.endsWith("end\n")).toBe(true);
  });

  it("reports a timeout as a null exit code and keeps going", async () => {
    const started = Date.now();
    const { results } = await runChecks(dir, ["echo before; sleep 30", "echo after"], {
      timeoutMs: 300,
    });
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.outputTail).toBe("before\n\n[timed out after 300 ms]");
    expect(results[1]).toEqual({ command: "echo after", exitCode: 0, outputTail: "after\n" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports a spawn error as a null exit code", async () => {
    const { results } = await runChecks(join(dir, "missing"), ["true"]);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.outputTail).not.toBe("");
  });
});
