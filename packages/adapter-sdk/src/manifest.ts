import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@switchyard/protocol";
import { validRange } from "semver";
import { z } from "zod";

export const MANIFEST_FILE = "switchyard-adapter.json";

/** Informational: shown in Settings and session details; the host does not enforce them. */
export const ADAPTER_CAPABILITIES = [
  "toolCards",
  "interactions",
  "panels",
  "progress",
  "subagents",
  "attention",
  "state",
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

/** Accepted in a manifest and dropped: `commands` had no effect on the host. */
const RETIRED_CAPABILITIES = ["commands"] as const;
const MANIFEST_CAPABILITIES = [...ADAPTER_CAPABILITIES, ...RETIRED_CAPABILITIES] as const;

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p), "must be a path relative to the manifest");

export const AdapterManifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, '.', '_' or '-'")
      .max(100),
    version: z.string().min(1),
    target: z.object({
      extension: z.string().min(1),
      versionRange: z.string().refine((r) => validRange(r) !== null, "invalid semver range"),
      testedVersions: z.array(z.string()),
    }),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    server: relativePath,
    webRenderer: relativePath.nullable(),
    capabilities: z
      .array(z.enum(MANIFEST_CAPABILITIES))
      .transform((c) =>
        c.filter(
          (x): x is AdapterCapability => !(RETIRED_CAPABILITIES as readonly string[]).includes(x),
        ),
      ),
  })
  .strict();
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly path: string | null,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ManifestError";
  }
}

/** Validate a manifest object. Throws ManifestError listing every issue. */
export function parseManifest(input: unknown, path: string | null = null): AdapterManifest {
  const r = AdapterManifestSchema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new ManifestError(`invalid adapter manifest: ${issues}`, path);
}

/**
 * Read and validate `switchyard-adapter.json`. `pathOrDir` may be the manifest file or the
 * directory containing it. Returns the manifest plus resolved absolute paths.
 */
export async function loadManifest(pathOrDir: string): Promise<{
  manifest: AdapterManifest;
  manifestPath: string;
  dir: string;
  serverPath: string;
  webRendererPath: string | null;
}> {
  const abs = resolve(pathOrDir);
  const manifestPath = abs.endsWith(".json") ? abs : join(abs, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    throw new ManifestError(`cannot read manifest (${(err as Error).message})`, manifestPath);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`manifest is not valid JSON (${(err as Error).message})`, manifestPath);
  }
  const manifest = parseManifest(json, manifestPath);
  const dir = dirname(manifestPath);
  return {
    manifest,
    manifestPath,
    dir,
    serverPath: resolve(dir, manifest.server),
    webRendererPath: manifest.webRenderer ? resolve(dir, manifest.webRenderer) : null,
  };
}
