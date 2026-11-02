import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fixtureExtensionPath,
  makePiEnv,
  makeRepo,
  piBin,
  realPiSkipReason,
  requirePi,
  startMockModel,
  when,
} from "../src/index.js";

async function chat(url: string, messages: unknown[]) {
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1", stream: true, messages }),
  });
  const body = await res.text();
  const chunks = body
    .split("\n\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("data: "))
    .map((s) => s.slice(6));
  expect(chunks.at(-1)).toBe("[DONE]");
  return chunks.slice(0, -1).map((c) => JSON.parse(c));
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("mock model server", () => {
  it("streams text, tool calls, finish reason and usage, and records requests", async () => {
    const mock = await startMockModel([
      {
        when: when.userSays("tool"),
        reply: { toolCalls: [{ name: "fixture_select", arguments: { a: 1 } }] },
      },
      { when: when.toolResult("fixture_select"), reply: (r) => ({ text: `got ${r.lastText}` }) },
    ]);
    cleanups.push(() => mock.close());

    const text = await chat(mock.url, [{ role: "user", content: "hi" }]);
    expect(text.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("ok");
    expect(text.at(-2).choices[0].finish_reason).toBe("stop");
    expect(text.at(-1).usage).toMatchObject({ prompt_tokens: 10 });

    const tool = await chat(mock.url, [
      { role: "user", content: [{ type: "text", text: "use a tool" }] },
    ]);
    const calls = tool.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls[0]).toMatchObject({
      index: 0,
      type: "function",
      function: { name: "fixture_select" },
    });
    expect(JSON.parse(calls.map((c: any) => c.function.arguments ?? "").join(""))).toEqual({
      a: 1,
    });
    expect(tool.at(-2).choices[0].finish_reason).toBe("tool_calls");

    const id = calls[0].id;
    const after = await chat(mock.url, [
      { role: "user", content: "use a tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id, type: "function", function: { name: "fixture_select", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: id, content: "Banana" },
    ]);
    expect(after.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("got Banana");
    expect(mock.requests).toHaveLength(3);
    expect(mock.requests[2]).toMatchObject({ lastRole: "tool", lastToolName: "fixture_select" });
  });
});

describe("pi env", () => {
  it("writes an isolated agent dir for the mock provider", () => {
    const env = makePiEnv({ mockUrl: "http://127.0.0.1:1/v1", extensions: ["/x/ext.js"] });
    cleanups.push(() => env.cleanup());
    const models = JSON.parse(readFileSync(join(env.agentDir, "models.json"), "utf8"));
    expect(models.providers.mock).toMatchObject({
      api: "openai-completions",
      apiKey: "mock",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    expect(models.providers.mock.models[0]).toMatchObject({
      id: "mock-1",
      contextWindow: 128000,
      maxTokens: 4096,
    });
    expect(JSON.parse(readFileSync(join(env.agentDir, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "mock",
      defaultModel: "mock-1",
    });
    expect(env.env).toEqual({
      PI_CODING_AGENT_DIR: env.agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    expect(env.args).toEqual(["--provider", "mock", "--model", "mock-1", "-e", "/x/ext.js"]);
    expect(existsSync(env.cwd)).toBe(true);
  });
});

describe("git repo", () => {
  it("creates a repo with one commit on main and an optional remote", () => {
    const repo = makeRepo({ remote: "git@github.com:example/repo.git" });
    cleanups.push(() => repo.cleanup());
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo.path, encoding: "utf8" }).trim();
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
    expect(git("remote", "get-url", "origin")).toBe("git@github.com:example/repo.git");
  });
});

describe("pi bin", () => {
  it("defaults to pi and only skips with SWITCHYARD_SKIP_REAL_PI=1", () => {
    if (!process.env.SWITCHYARD_PI_BIN) expect(piBin()).toBe("pi");
    expect(realPiSkipReason() === null).toBe(process.env.SWITCHYARD_SKIP_REAL_PI !== "1");
  });

  it("ships the compiled fixture extension", () => {
    expect(fixtureExtensionPath()).toMatch(/dist\/fixture-extension\.js$/);
    expect(existsSync(fixtureExtensionPath())).toBe(true);
  });

  it("requirePi fails loudly when Pi is missing", () => {
    const saved = process.env.SWITCHYARD_PI_BIN;
    process.env.SWITCHYARD_PI_BIN = "/nonexistent/pi";
    try {
      expect(() => requirePi()).toThrow(/Real-Pi tests need a working Pi/);
    } finally {
      if (saved === undefined) delete process.env.SWITCHYARD_PI_BIN;
      else process.env.SWITCHYARD_PI_BIN = saved;
    }
  });
});
