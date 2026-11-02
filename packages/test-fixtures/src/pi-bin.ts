import { execFileSync } from "node:child_process";

/** The Pi binary used by real-Pi tests (`SWITCHYARD_PI_BIN` overrides `pi`). */
export function piBin(): string {
  return process.env.SWITCHYARD_PI_BIN ?? "pi";
}

/**
 * Reason real-Pi tests are skipped, or null when they must run.
 * Only `SWITCHYARD_SKIP_REAL_PI=1` skips; a missing Pi is a failure, not a skip.
 */
export function realPiSkipReason(): string | null {
  return process.env.SWITCHYARD_SKIP_REAL_PI === "1"
    ? "SWITCHYARD_SKIP_REAL_PI=1: real-Pi tests skipped"
    : null;
}

/** True when real-Pi tests should be skipped (for `describe.skipIf`). */
export const skipRealPi: boolean = realPiSkipReason() !== null;

/** Returns the installed Pi version or throws a clear error so real-Pi tests fail instead of passing. */
export function requirePi(): string {
  const bin = piBin();
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    });
    const match = out.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
    if (!match) throw new Error(`unexpected output: ${out.trim()}`);
    return match[0];
  } catch (err) {
    throw new Error(
      `Real-Pi tests need a working Pi: \`${bin} --version\` failed (${(err as Error).message}). ` +
        "Install Pi, set SWITCHYARD_PI_BIN, or set SWITCHYARD_SKIP_REAL_PI=1 to skip these tests.",
    );
  }
}
