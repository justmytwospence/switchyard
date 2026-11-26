import { hostname } from "node:os";
import type { Client, ClientBindingInput, Scope } from "@switchyard/protocol";
import { clientOpen, findScope } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { ago, type Ctx, connect, printList } from "../context.js";
import { isUnknownRoute } from "../mirror/binding.js";

export interface ClientFlags extends ConnectionFlags {
  json?: boolean;
  scope?: string;
  /** Hidden: the old name of `--scope`. */
  view?: string;
  all?: boolean;
  none?: boolean;
}

/** Every client (herdr and tmux sessions) the coordinator knows. */
export function listClients(api: ApiClient): Promise<Client[]> {
  return api.get<Client[]>("/api/clients");
}

/** What a client mirrors, for a table. */
export function mirrorText(t: Client, scopes: Scope[]): string {
  if (t.mirror === "all") return "everything";
  if (t.mirror === "scope")
    return `scope ${scopes.find((v) => v.id === t.scopeId)?.name ?? t.scopeId}`;
  return t.bindingSetAt ? "nothing" : "nothing (not recorded)";
}

/**
 * A client id from what was typed: an id (`herdr:work@mac`), `<kind>:<name>` on this machine,
 * or the name of exactly one known client.
 */
export function resolveClientRef(ref: string, known: Client[], machine = hostname()): string {
  if (/^[a-z][a-z0-9-]*:.+@[^@]+$/.test(ref)) return ref;
  if (/^[a-z][a-z0-9-]*:[^@]+$/.test(ref)) return `${ref}@${machine}`;
  const named = known.filter((t) => t.name === ref);
  const here = named.filter((t) => t.machine === machine);
  const pick = here.length === 1 ? here : named;
  if (pick.length === 1) return pick[0]!.id;
  if (pick.length > 1) {
    throw new CliError(`"${ref}" names several clients: ${pick.map((t) => t.id).join(", ")}`);
  }
  throw new CliError(
    `Unknown client "${ref}". Give it as <kind>:<session> (on this machine) or <kind>:<session>@<machine>`,
  );
}

/** The binding the flags ask for (exactly one of --scope, --all, --none). */
export async function bindingFromFlags(
  api: ApiClient,
  flags: Pick<ClientFlags, "scope" | "view" | "all" | "none">,
): Promise<ClientBindingInput> {
  const ref = flags.scope ?? flags.view;
  const chosen = [ref !== undefined, !!flags.all, !!flags.none].filter(Boolean).length;
  if (chosen !== 1) throw new CliError("Choose one of --scope <name>, --all or --none");
  if (flags.all) return { mirror: "all" };
  if (flags.none) return { mirror: "none" };
  const scopes = await api.get<Scope[]>("/api/scopes");
  const v = findScope(scopes, ref!);
  if (!v) {
    const known = scopes.map((x) => x.name).join(", ") || "none";
    throw new CliError(`Unknown scope "${ref}". Scopes: ${known}`);
  }
  return { mirror: "scope", scopeId: v.id };
}

/** Record what a client mirrors. */
export async function recordBinding(
  api: ApiClient,
  id: string,
  binding: ClientBindingInput,
): Promise<Client> {
  try {
    return await api.request<Client>(
      "PUT",
      `/api/clients/${encodeURIComponent(id)}/binding`,
      binding,
    );
  } catch (err) {
    if (isUnknownRoute(err)) {
      throw new CliError(
        "This coordinator is older than this CLI and has no clients: upgrade the coordinator",
      );
    }
    throw err;
  }
}

/** `switchyard clients list` */
export async function clientsList(ctx: Ctx, flags: ClientFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const [clients, scopes] = await Promise.all([listClients(api), api.get<Scope[]>("/api/scopes")]);
  printList(
    ctx,
    flags.json,
    clients,
    ["CLIENT", "MIRRORS", "TABS", "DAEMON"],
    clients.map((t) => [
      t.id,
      mirrorText(t, scopes),
      String(t.shows?.length ?? 0),
      clientOpen(t) ? `seen ${ago(t.lastSeenAt)}` : "not running",
    ]),
    "No clients yet: start a herdr or tmux session with the Switchyard plugin.",
  );
}

/** `switchyard clients bind <client> --scope <name> | --all | --none` */
export async function clientsBind(ctx: Ctx, ref: string, flags: ClientFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const binding = await bindingFromFlags(api, flags);
  const id = resolveClientRef(ref, await listClients(api).catch(() => []));
  const [t, scopes] = await Promise.all([
    recordBinding(api, id, binding),
    api.get<Scope[]>("/api/scopes"),
  ]);
  ctx.out(`${t.id} mirrors ${mirrorText(t, scopes)}`);
}

/** `switchyard clients forget <client>`: drop a client and its binding. */
export async function clientsForget(ctx: Ctx, ref: string, flags: ClientFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const id = resolveClientRef(ref, await listClients(api));
  await api.request("DELETE", `/api/clients/${encodeURIComponent(id)}`);
  ctx.out(`Forgot ${id}`);
}
