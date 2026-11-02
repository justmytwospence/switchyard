import { execFile } from "node:child_process";
import {
  PI_SUPPORTED_RANGE,
  type RuntimeCapabilities,
  SwitchyardError,
} from "@switchyard/protocol";
import semver from "semver";

/** Pi versions Switchyard is tested against. */
export const SUPPORTED_RANGE: string = PI_SUPPORTED_RANGE;

/** Capabilities of Pi's RPC mode within the supported range (verified by the gate tests). */
export const PI_RPC_CAPABILITIES: RuntimeCapabilities = {
  prompt: true,
  steer: true,
  followUp: true,
  abort: true,
  resume: true,
  rename: true,
  importInactive: true,
  extensionDialogs: true,
  customUi: false,
  widgetsText: true,
  widgetsComponent: false,
  tokenAccounting: true,
  costAccounting: true,
  unsupported: [
    { capability: "customUi", reason: "ctx.ui.custom() returns undefined in RPC mode" },
    {
      capability: "widgetsComponent",
      reason: "component widget factories are ignored in RPC mode",
    },
  ],
};

/** Capabilities reported when Pi is missing or outside the supported range. */
export function noCapabilities(reason: string): RuntimeCapabilities {
  return {
    prompt: false,
    steer: false,
    followUp: false,
    abort: false,
    resume: false,
    rename: false,
    importInactive: false,
    extensionDialogs: false,
    customUi: false,
    widgetsText: false,
    widgetsComponent: false,
    tokenAccounting: false,
    costAccounting: false,
    unsupported: [{ capability: "all", reason }],
  };
}

export interface PiDetection {
  /** Parsed version, or null when `pi --version` failed. */
  version: string | null;
  compatible: boolean;
  capabilities: RuntimeCapabilities;
  /** Why Pi is unusable, or null when compatible. */
  reason: string | null;
}

export function incompatibleMessage(version: string): string {
  return `Pi ${version} is outside the tested range ${SUPPORTED_RANGE}`;
}

export function isSupportedVersion(version: string): boolean {
  // Prereleases are untested and do not satisfy the range (semver default).
  const v = semver.valid(version) ?? semver.coerce(version)?.version ?? null;
  return v !== null && semver.satisfies(v, SUPPORTED_RANGE);
}

/** Run `<piBin> --version` and evaluate compatibility. Never throws. */
export async function detectPi(
  piBin = "pi",
  env: Record<string, string | undefined> = {},
): Promise<PiDetection> {
  let out: string;
  try {
    out = await new Promise<string>((resolve, reject) => {
      execFile(
        piBin,
        ["--version"],
        {
          timeout: 30000,
          env: {
            ...process.env,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_TELEMETRY: "0",
            ...env,
          },
        },
        (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)),
      );
    });
  } catch (err) {
    const reason = `Pi not available: \`${piBin} --version\` failed (${(err as Error).message})`;
    return { version: null, compatible: false, capabilities: noCapabilities(reason), reason };
  }
  const match = out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  if (!match) {
    const reason = `Could not parse Pi version from: ${out.trim().slice(0, 200)}`;
    return { version: null, compatible: false, capabilities: noCapabilities(reason), reason };
  }
  const version = match[0];
  if (!isSupportedVersion(version)) {
    const reason = incompatibleMessage(version);
    return { version, compatible: false, capabilities: noCapabilities(reason), reason };
  }
  return {
    version,
    compatible: true,
    capabilities: structuredClone(PI_RPC_CAPABILITIES),
    reason: null,
  };
}

/** Throw `pi_incompatible` unless the detected Pi is usable. */
export function assertCompatible(detection: PiDetection): void {
  if (!detection.compatible) {
    throw new SwitchyardError(
      "pi_incompatible",
      detection.reason ?? "Pi is not compatible",
      detection.version ? { version: detection.version, range: SUPPORTED_RANGE } : undefined,
    );
  }
}
