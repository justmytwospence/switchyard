import { hostname } from "node:os";
import type { Terminal, TerminalBindingInput, View } from "@switchyard/protocol";
import { findView, terminalMirror, terminalOpen } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { CliError, type ConnectionFlags } from "../config.js";
import { ago, type Ctx, connect, printList } from "../context.js";
import { isUnknownRoute, listTerminals } from "./views.js";

export interface TerminalFlags extends ConnectionFlags {
  json?: boolean;
  view?: string;
  all?: boolean;
  none?: boolean;
}

/** What a terminal mirrors, for a table. */
export function mirrorText(t: Terminal, views: View[]): string {
  const m = terminalMirror(t);
  if (m === "all") return "everything";
  if (m === "view") return `view ${views.find((v) => v.id === t.viewId)?.name ?? t.viewId}`;
  return t.bindingSetAt ? "nothing" : "nothing (not recorded)";
}

/**
 * A terminal id from what was typed: an id (`herdr:work@mac`), `<kind>:<name>` on this machine,
 * or the name of exactly one known terminal.
 */
export function resolveTerminalRef(ref: string, known: Terminal[], machine = hostname()): string {
  if (/^(herdr|tmux):.+@[^@]+$/.test(ref)) return ref;
  if (/^(herdr|tmux):[^@]+$/.test(ref)) return `${ref}@${machine}`;
  const named = known.filter((t) => t.name === ref);
  const here = named.filter((t) => t.machine === machine);
  const pick = here.length === 1 ? here : named;
  if (pick.length === 1) return pick[0]!.id;
  if (pick.length > 1) {
    throw new CliError(`"${ref}" names several terminals: ${pick.map((t) => t.id).join(", ")}`);
  }
  throw new CliError(
    `Unknown terminal "${ref}". Give it as herdr:<session> or tmux:<session> (on this machine), or herdr:<session>@<machine>`,
  );
}

/** The binding the flags ask for (exactly one of --view, --all, --none). */
export async function bindingFromFlags(
  api: ApiClient,
  flags: Pick<TerminalFlags, "view" | "all" | "none">,
): Promise<TerminalBindingInput> {
  const chosen = [flags.view !== undefined, !!flags.all, !!flags.none].filter(Boolean).length;
  if (chosen !== 1) throw new CliError("Choose one of --view <name>, --all or --none");
  if (flags.all) return { mirror: "all" };
  if (flags.none) return { mirror: "none" };
  const views = await api.get<View[]>("/api/views");
  const v = findView(views, flags.view!);
  if (!v) {
    const known = views.map((x) => x.name).join(", ") || "none";
    throw new CliError(`Unknown view "${flags.view}". Views: ${known}`);
  }
  return { mirror: "view", viewId: v.id };
}

/** Record what a terminal mirrors. */
export async function recordBinding(
  api: ApiClient,
  id: string,
  binding: TerminalBindingInput,
): Promise<Terminal> {
  try {
    return await api.request<Terminal>(
      "PUT",
      `/api/terminals/${encodeURIComponent(id)}/binding`,
      binding,
    );
  } catch (err) {
    if (isUnknownRoute(err)) {
      throw new CliError(
        "This coordinator cannot record bindings yet: upgrade it, or set SWITCHYARD_VIEW in the env file",
      );
    }
    throw err;
  }
}

/** `switchyard terminals list` */
export async function terminalsList(ctx: Ctx, flags: TerminalFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const [terminals, views] = await Promise.all([listTerminals(api), api.get<View[]>("/api/views")]);
  printList(
    ctx,
    flags.json,
    terminals,
    ["TERMINAL", "MIRRORS", "TABS", "DAEMON"],
    terminals.map((t) => [
      t.id,
      mirrorText(t, views),
      String(t.shows?.length ?? 0),
      terminalOpen(t) ? `seen ${ago(t.lastSeenAt)}` : "not running",
    ]),
    "No terminals yet: start a herdr or tmux session with the Switchyard plugin.",
  );
}

/** `switchyard terminals bind <terminal> --view <name> | --all | --none` */
export async function terminalsBind(ctx: Ctx, ref: string, flags: TerminalFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const binding = await bindingFromFlags(api, flags);
  const id = resolveTerminalRef(ref, await listTerminals(api).catch(() => []));
  const [t, views] = await Promise.all([
    recordBinding(api, id, binding),
    api.get<View[]>("/api/views"),
  ]);
  ctx.out(`${t.id} mirrors ${mirrorText(t, views)}`);
}

/** `switchyard terminals forget <terminal>`: drop a terminal and its binding. */
export async function terminalsForget(ctx: Ctx, ref: string, flags: TerminalFlags): Promise<void> {
  const { api } = connect(ctx, flags);
  const id = resolveTerminalRef(ref, await listTerminals(api));
  await api.request("DELETE", `/api/terminals/${encodeURIComponent(id)}`);
  ctx.out(`Forgot ${id}`);
}
