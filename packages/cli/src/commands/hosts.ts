import type { Host } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { type Ctx, connect, printList } from "../context.js";
import type { ListFlags } from "./work.js";

type LocationHost = Host & { checkoutRoot?: string | null };
const guidance =
  "Project folders and scanning have been retired. Projects come from your Git provider; use `switchyard hosts location <host>` to manage the checkout location.";

/** Accept a host id or a (case-insensitive) unique host name; revoked hosts are ignored. */
export async function resolveHost(api: ApiClient, ref: string): Promise<LocationHost> {
  const hosts = (await api.get<LocationHost[]>("/api/hosts")).filter((h) => !h.revokedAt);
  const exact = hosts.find((h) => h.id === ref);
  if (exact) return exact;
  const named = hosts.filter((h) => h.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new CliError(`Several hosts are named "${ref}"; use the id`);
  const known = hosts.map((h) => `${h.name} (${h.id})`).join(", ") || "none";
  throw new CliError(`Unknown host "${ref}". Hosts: ${known}`);
}

export async function hostsList(ctx: Ctx, flags: ListFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const hosts = (await api.get<LocationHost[]>("/api/hosts")).filter((h) => !h.revokedAt);
  printList(
    ctx,
    flags.json,
    hosts,
    ["ID", "NAME", "STATUS", "AGENT", "CHECKOUT LOCATION"],
    hosts.map((h) => [h.id, h.name, h.connectivity, h.agentVersion, h.checkoutRoot ?? "-"]),
    "No hosts.",
  );
}

export interface LocationFlags extends ConnectionFlags {
  set?: string;
  clear?: boolean;
  json?: boolean;
}

export async function hostsLocation(
  ctx: Ctx,
  ref: string,
  flags: LocationFlags,
): Promise<LocationHost> {
  if (flags.set !== undefined && flags.clear) throw new CliError("Use --set or --clear, not both");
  const { api } = connect(ctx, flags);
  const host = await resolveHost(api, ref);
  const updated =
    flags.set !== undefined || flags.clear
      ? await api.request<LocationHost>("PATCH", `/api/hosts/${encodeURIComponent(host.id)}`, {
          checkoutRoot: flags.clear ? null : flags.set,
        })
      : host;
  if (flags.json) ctx.out(JSON.stringify(updated, null, 2));
  else ctx.out(`Checkout location on ${updated.name}: ${updated.checkoutRoot ?? "none"}`);
  return updated;
}

export interface FoldersFlags extends ConnectionFlags {
  set?: string[];
  add?: string[];
  remove?: string[];
  clear?: boolean;
  json?: boolean;
}

export async function hostsFolders(
  ctx: Ctx,
  ref: string,
  flags: FoldersFlags,
): Promise<LocationHost> {
  if (flags.set || flags.add || flags.remove || flags.clear) throw new CliError(guidance);
  ctx.err(guidance);
  return hostsLocation(ctx, ref, { ...flags, set: undefined });
}

export async function hostsScan(_ctx: Ctx, _ref: string, _flags: ListFlags): Promise<never> {
  throw new CliError(guidance);
}
