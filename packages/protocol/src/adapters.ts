import { z } from "zod";
import { AdapterInfo, Diagnostic } from "./entities.js";

const Path = z.string().max(4096);
export const SessionAdapterInfo = AdapterInfo.extend({
  runtimeStatus: z.enum(["active", "disabled", "unavailable"]),
  runtimeDetail: z.string().max(4000).nullable(),
  provenance: z.object({
    scope: z.enum(["user", "project", "explicit"]),
    source: Path.nullable(),
    packageDir: Path.nullable(),
    manifestPath: Path.nullable(),
    targetVersion: z.string().nullable(),
    entrypoints: z.array(Path).max(128),
    evidence: z.enum(["runtime-reported", "package-level", "explicit"]),
  }),
});
export type SessionAdapterInfo = z.infer<typeof SessionAdapterInfo>;

export const SessionAdaptersResult = z.object({
  generation: z.string().uuid().nullable(),
  runtimeId: z.string().nullable(),
  reloadable: z.boolean(),
  blockedReason: z.string().nullable(),
  adapters: z.array(SessionAdapterInfo).max(256),
  diagnostics: z.array(Diagnostic).max(100),
});
export type SessionAdaptersResult = z.infer<typeof SessionAdaptersResult>;
