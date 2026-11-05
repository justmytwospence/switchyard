import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_TIMEOUT_MS, OUTPUT_TAIL_BYTES, runChecks, stopAllShells } from "../src/checks.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

  it("a timeout also kills background grandchildren", async () => {
    await runChecks(dir, ["sleep 30 & echo $! > bg.pid; sleep 30"], { timeoutMs: 300 });
    const pid = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
    await until(() => !alive(pid), 5000);
  });

  it("stopAllShells ends running commands", async () => {
    const p = runChecks(dir, ["sleep 30 & echo $! > bg.pid; wait"], { timeoutMs: 60_000 });
    await until(
      () =>
        existsSync(join(dir, "bg.pid")) && readFileSync(join(dir, "bg.pid"), "utf8").trim() !== "",
      5000,
    );
    const pid = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
    expect(await stopAllShells(500)).toBe(1);
    expect((await p).results[0]!.exitCode).toBeNull();
    await until(() => !alive(pid), 5000);
  });

  it("leaves background processes of a command that exits on its own", async () => {
    await runChecks(dir, ["sleep 3 & echo $! > bg.pid"]);
    const pid = Number(readFileSync(join(dir, "bg.pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  });

  it("reports a spawn error as a null exit code", async () => {
    const { results } = await runChecks(join(dir, "missing"), ["true"]);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.outputTail).not.toBe("");
  });
});
