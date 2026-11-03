import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PiEnvOptions {
  /** Mock model base URL including `/v1` (from `startMockModel().url`). */
  mockUrl: string;
  /** Absolute extension paths, each passed as `-e <path>`. */
  extensions?: string[];
  /** Extra `settings.json` keys merged over the defaults. */
  settings?: Record<string, unknown>;
}

export interface PiEnv {
  /** Temp root holding `agent/` and `work/`. */
  root: string;
  /** `PI_CODING_AGENT_DIR` (contains models.json, settings.json, sessions/). */
  agentDir: string;
  /** Default sessions root inside the agent dir. */
  sessionsDir: string;
  /** An empty working directory for Pi to run in. */
  cwd: string;
  /** Environment variables to add to the child process. */
  env: Record<string, string>;
  /** Arguments selecting the mock model and loading the extensions. */
  args: string[];
  cleanup(): void;
}

/** Create an isolated Pi agent directory pointing provider `mock` at the mock model server. */
export function makePiEnv(opts: PiEnvOptions): PiEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-pi-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const models = {
    providers: {
      mock: {
        baseUrl: opts.mockUrl,
        api: "openai-completions",
        apiKey: "mock",
        models: [
          {
            id: "mock-1",
            name: "Mock 1",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "mock-2",
            name: "Mock 2",
            reasoning: true,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`);
  const settings = { defaultProvider: "mock", defaultModel: "mock-1", ...(opts.settings ?? {}) };
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const args = ["--provider", "mock", "--model", "mock-1"];
  for (const ext of opts.extensions ?? []) args.push("-e", ext);
  return {
    root,
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    cwd,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    },
    args,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
