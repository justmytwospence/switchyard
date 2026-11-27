import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Profile } from "@switchyard/protocol";
import {
  fixtureExtensionPath,
  type MockModelServer,
  type MockScript,
  makePiEnv,
  type PiEnv,
  piBin,
  requirePi,
  skipRealPi,
  startMockModel,
} from "@switchyard/test-fixtures";
import { bridgeExtensionPath } from "../src/index.js";
import { ManagedSession, type ManagedSessionOptions } from "../src/session-runtime.js";
import { PiTerminalProcess } from "../src/terminal-process.js";
import { makeRuntimeTerminalScope } from "./terminal-scope.js";

export { skipRealPi };

export const mockProfile: Pick<
  Profile,
  "provider" | "model" | "thinking" | "projectTrust" | "extraArgs"
> = {
  provider: "mock",
  model: "mock-1",
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};

export interface PiHarness {
  mock: MockModelServer;
  env: PiEnv;
  sessions: ManagedSession[];
  terminalScope: ReturnType<typeof makeRuntimeTerminalScope>;
  newSession(overrides?: Partial<ManagedSessionOptions>): ManagedSession;
  dispose(): Promise<void>;
}

/** Real Pi + mock model + isolated agent dir. Fails (never skips) when Pi is missing. */
export async function setupPi(
  script: MockScript,
  opts: { settings?: Record<string, unknown> } = {},
): Promise<PiHarness> {
  requirePi();
  if (!existsSync(bridgeExtensionPath())) {
    throw new Error(
      `Bridge extension not built: ${bridgeExtensionPath()} (run tsc -b packages/pi-runtime)`,
    );
  }
  if (!existsSync(fixtureExtensionPath())) {
    throw new Error(`Fixture extension not built: ${fixtureExtensionPath()}`);
  }
  const terminalScope = makeRuntimeTerminalScope(PiTerminalProcess);
  let mock: MockModelServer;
  let env: PiEnv;
  try {
    mock = await startMockModel(script);
    try {
      env = makePiEnv({ mockUrl: mock.url, settings: opts.settings });
    } catch (error) {
      await mock.close();
      throw error;
    }
  } catch (error) {
    await terminalScope.dispose();
    throw error;
  }
  const sessions: ManagedSession[] = [];
  terminalScope.onStop(async () => {
    const results = await Promise.allSettled(
      sessions.map((s) => s.stop({ graceMs: 3000, termMs: 1000 })),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "session teardown failed",
      );
  });
  let n = 0;
  let disposal: Promise<void> | undefined;
  return {
    mock,
    env,
    sessions,
    terminalScope,
    newSession(overrides = {}) {
      const s = new ManagedSession({
        sessionId: `ses_test${++n}`,
        cwd: env.cwd,
        title: "Gate test",
        profile: mockProfile,
        piBin: piBin(),
        env: env.env,
        extensions: [fixtureExtensionPath()],
        ...overrides,
        runtimeDir: terminalScope.runtimeDir,
      });
      sessions.push(s);
      return s;
    },
    dispose() {
      disposal ??= (async () => {
        const errors: unknown[] = [];
        let clean = false;
        try {
          await terminalScope.dispose();
          clean = true;
        } catch (error) {
          errors.push(error);
        }
        try {
          await mock.close();
        } catch (error) {
          errors.push(error);
        }
        if (clean) env.cleanup();
        if (errors.length)
          throw new AggregateError(errors, `Pi fixture cleanup failed; retained ${env.root}`);
      })();
      return disposal;
    },
  };
}

/** Wait for an event whose payload matches `pred`. */
export function waitFor<T = any>(
  emitter: EventEmitter<any>,
  event: string,
  pred: (value: T) => boolean = () => true,
  timeoutMs = 20000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (value: T) => {
      if (!pred(value)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(value);
    };
    emitter.on(event, handler);
  });
}

/** Record every emission of the given events, in order. */
export function record(
  emitter: EventEmitter<any>,
  events: string[],
): { log: { event: string; value: any }[]; of: (event: string) => any[] } {
  const log: { event: string; value: any }[] = [];
  for (const event of events) {
    emitter.on(event, (value: any) => log.push({ event, value: structuredClone(value) }));
  }
  return { log, of: (event) => log.filter((e) => e.event === event).map((e) => e.value) };
}
