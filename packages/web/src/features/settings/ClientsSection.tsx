import type { Client, ClientBindingInput, Device, Scope } from "@switchyard/protocol";
import { clientOpen } from "@switchyard/protocol";
import {
  BellOff,
  BellRing,
  CircleCheck,
  CircleOff,
  Eraser,
  Laptop,
  MonitorSmartphone,
  Pencil,
  ShieldOff,
  Smartphone,
  SquareTerminal,
  Star,
  Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { currentDeviceId, useAuth } from "../../app/auth";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { InlineStatus } from "../../components/ui/StatusChip";
import { EmptyState, LastKnownNote, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiDelete, apiPatch, apiPost, apiPut, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { SectionPage, useHydrated } from "./shared";

export const DEVICE_KIND_LABEL: Record<Device["kind"], string> = {
  browser: "Browser",
  pwa: "Home Screen app",
  terminal: "Terminal",
  cli: "CLI",
};

const PERMISSION_LABEL: Record<Device["push"]["permission"], string> = {
  granted: "allowed",
  denied: "blocked",
  default: "not requested",
  unknown: "unknown",
};

function KindIcon({ kind }: { kind: Device["kind"] }) {
  const Icon = kind === "pwa" ? Smartphone : kind === "browser" ? Laptop : Terminal;
  return <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />;
}

/** The select value for a client's binding: "none", "all" or "scope:<id>". */
export function bindingValue(c: Pick<Client, "mirror" | "scopeId">): string {
  return c.mirror === "scope" ? `scope:${c.scopeId}` : c.mirror;
}

export function bindingFromValue(value: string): ClientBindingInput {
  if (value.startsWith("scope:")) return { mirror: "scope", scopeId: value.slice(6) };
  return { mirror: value === "all" ? "all" : "none" };
}

/** The grey line under a herdr or tmux session: where, signed in with what, and how lately. */
export function clientFacts(
  c: Client,
  ctx: { device?: Pick<Device, "name" | "revokedAt">; hostName?: string },
  now = Date.now(),
): string[] {
  const facts = [`on ${ctx.hostName || c.machine}`];
  if (ctx.device) {
    facts.push(
      ctx.device.revokedAt !== null
        ? "its device was revoked"
        : `signed in with ${ctx.device.name}`,
    );
  }
  if (clientOpen(c, now)) {
    const n = c.shows?.length ?? 0;
    if (n > 0) facts.push(`${n} session${n === 1 ? "" : "s"} mirrored`);
  } else if (Date.parse(c.lastSeenAt) <= 0) {
    facts.push("never seen");
  } else {
    facts.push(`last seen ${formatRelative(c.lastSeenAt, now)}`);
  }
  return facts;
}

/** A herdr or tmux session: where it runs, whether its plugin reports, and what it mirrors. */
function ClientRow({
  client: c,
  scopes,
  device,
  hostName,
  onForget,
}: {
  client: Client;
  scopes: Scope[];
  device: Device | undefined;
  hostName: string | undefined;
  onForget: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const value = bindingValue(c);
  const open = clientOpen(c);
  const scopeGone = c.mirror === "scope" && !scopes.some((v) => v.id === c.scopeId);
  const bind = async (next: string) => {
    setBusy(true);
    try {
      await apiPut(`/api/clients/${encodeURIComponent(c.id)}/binding`, bindingFromValue(next));
    } catch (e) {
      toast.error(`Could not change ${c.kind} ${c.name}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="client-row"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0"
    >
      <SquareTerminal aria-hidden className="mt-0.5 size-5 shrink-0 self-start text-muted" />
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span data-testid="client-name" className="min-w-0 break-words font-medium">
            {c.kind} {c.name}
          </span>
          <InlineStatus
            icon={open ? CircleCheck : CircleOff}
            tone={open ? "success" : "neutral"}
            label={open ? "Running" : "Not running"}
          />
        </div>
        <p className="min-w-0 break-words text-sm text-muted">
          {clientFacts(c, { device, hostName }).join(" · ")}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span aria-hidden className="text-muted">
          Mirrors
        </span>
        <Select
          width="auto"
          aria-label={`What ${c.kind} ${c.name} mirrors`}
          value={value}
          disabled={busy}
          onChange={(e) => void bind(e.target.value)}
        >
          <option value="none">Nothing</option>
          <option value="all">Everything</option>
          {scopes.map((v) => (
            <option key={v.id} value={`scope:${v.id}`}>
              Scope: {v.name}
            </option>
          ))}
          {scopeGone && <option value={value}>Deleted scope</option>}
        </Select>
        {!open && (
          <Button size="sm" variant="ghost" icon={<Eraser className="size-4" />} onClick={onForget}>
            Forget
          </Button>
        )}
      </div>
    </li>
  );
}

/** Settings › Clients: signed-in devices, and the herdr and tmux sessions on them. */
export function ClientsSection() {
  const hydrated = useHydrated();
  const devicesById = useSyncStore((s) => s.devices);
  const clientsById = useSyncStore((s) => s.clients);
  const scopesById = useSyncStore((s) => s.scopes);
  const hosts = useSyncStore((s) => s.hosts);
  const scopes = useMemo(
    () => Object.values(scopesById).sort((a, b) => a.name.localeCompare(b.name)),
    [scopesById],
  );
  const clients = useMemo(
    () =>
      Object.values(clientsById).sort(
        (a, b) => a.machine.localeCompare(b.machine) || a.id.localeCompare(b.id),
      ),
    [clientsById],
  );
  useAuth((s) => s.me); // re-render when the current device becomes known
  const thisId = currentDeviceId();
  const devices = useMemo(
    () =>
      Object.values(devicesById)
        .filter((d) => d.revokedAt === null)
        .sort(
          (a, b) =>
            Number(b.id === thisId) - Number(a.id === thisId) ||
            (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
        ),
    [devicesById, thisId],
  );
  const [renaming, setRenaming] = useState<Device | null>(null);
  const [draft, setDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<unknown>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(null);
  const [forgetting, setForgetting] = useState<Client | null>(null);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState<unknown>(null);
  const [preferBusy, setPreferBusy] = useState<string | null>(null);

  const revoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await apiPost(`/api/devices/${encodeURIComponent(revoking.id)}/revoke`);
      toast.success(`${revoking.name} revoked`);
      setRevoking(null);
    } catch (e) {
      setRevokeError(e);
    } finally {
      setRevokeBusy(false);
    }
  };

  const forget = async () => {
    if (!forgetting) return;
    setForgetBusy(true);
    setForgetError(null);
    try {
      await apiDelete(`/api/clients/${encodeURIComponent(forgetting.id)}`);
      toast.success(`${forgetting.kind} ${forgetting.name} forgotten`);
      setForgetting(null);
    } catch (e) {
      setForgetError(e);
    } finally {
      setForgetBusy(false);
    }
  };

  const prefer = async (d: Device) => {
    setPreferBusy(d.id);
    try {
      await apiPatch(`/api/devices/${encodeURIComponent(d.id)}`, { preferredMobile: true });
      toast.success(`${d.name} is now the preferred mobile device`);
    } catch (e) {
      toast.error(`Could not set the preferred device: ${errorMessage(e)}`);
    } finally {
      setPreferBusy(null);
    }
  };

  const rename = async () => {
    if (!renaming) return;
    const name = draft.trim();
    if (!name) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await apiPatch(`/api/devices/${encodeURIComponent(renaming.id)}`, { name });
      toast.success(`Renamed to ${name}`);
      setRenaming(null);
    } catch (e) {
      setRenameError(e);
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <SectionPage
      testId="settings-clients"
      title="Clients"
      description="What is signed in to this coordinator."
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading clients…" />
      ) : devices.length === 0 && clients.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone className="size-8" />}
          title="No clients"
          description="Browsers and CLIs appear here once they sign in."
        />
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">herdr and tmux sessions</h2>
            <p className="text-sm text-muted">
              Each mirrors nothing, everything, or one scope, as a tab or window per active branch.
            </p>
            {clients.length === 0 ? (
              <p className="text-sm text-muted">
                None yet. A session appears once the Switchyard plugin runs in it, or after
                switchyard clients bind.
              </p>
            ) : (
              <ul
                data-testid="client-list"
                className="overflow-hidden rounded-lg border border-border bg-surface"
              >
                {clients.map((x) => (
                  <ClientRow
                    key={x.id}
                    client={x}
                    scopes={scopes}
                    device={devicesById[x.deviceId]}
                    hostName={x.hostId ? hosts[x.hostId]?.name : undefined}
                    onForget={() => {
                      setForgetError(null);
                      setForgetting(x);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Devices</h2>
            <p className="text-sm text-muted">
              Browsers, Home Screen apps and CLIs signed in here. Revoke one to sign it out. The
              preferred mobile device receives push notifications when no desktop was recently
              active.
            </p>
            <ul
              data-testid="device-list"
              className="overflow-hidden rounded-lg border border-border bg-surface"
            >
              {devices.map((d) => {
                const isThis = d.id === thisId;
                const pushes = d.kind === "browser" || d.kind === "pwa";
                const sessions = clients.filter((x) => x.deviceId === d.id).length;
                return (
                  <li
                    key={d.id}
                    data-testid="device-row"
                    className="flex min-w-0 flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <KindIcon kind={d.kind} />
                    <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words font-medium">{d.name}</span>
                        {isThis && <InlineStatus icon={Laptop} tone="info" label="This device" />}
                        {d.preferredMobile && (
                          <InlineStatus icon={Star} tone="success" label="Preferred mobile" />
                        )}
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                        <span>{DEVICE_KIND_LABEL[d.kind]}</span>
                        <span>Last seen {formatRelative(d.lastSeenAt)}</span>
                        {pushes && (
                          <span className="inline-flex items-center gap-1">
                            {d.push.subscribed ? (
                              <BellRing aria-hidden className="size-4 shrink-0" />
                            ) : (
                              <BellOff aria-hidden className="size-4 shrink-0" />
                            )}
                            {d.push.subscribed ? "Push subscribed" : "No push subscription"},
                            permission {PERMISSION_LABEL[d.push.permission]}
                          </span>
                        )}
                        {sessions > 0 && (
                          <span>
                            {sessions} herdr or tmux session{sessions === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {pushes && !d.preferredMobile && (
                        <Button
                          size="sm"
                          icon={<Star className="size-4" />}
                          busy={preferBusy === d.id}
                          onClick={() => prefer(d)}
                        >
                          Set as preferred mobile device
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="device-rename"
                        icon={<Pencil className="size-4" />}
                        onClick={() => {
                          setRenameError(null);
                          setDraft(d.name);
                          setRenaming(d);
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        icon={<ShieldOff className="size-4" />}
                        onClick={() => {
                          setRevokeError(null);
                          setRevoking(d);
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      <ConfirmDialog
        open={forgetting !== null}
        onClose={() => setForgetting(null)}
        title={forgetting ? `Forget ${forgetting.kind} ${forgetting.name}?` : "Forget client"}
        confirmLabel="Forget client"
        busy={forgetBusy}
        error={forgetError}
        onConfirm={forget}
      >
        <p className="text-sm">
          What it mirrors is no longer recorded. The session appears again once its plugin runs.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename device"
        confirmLabel="Save"
        danger={false}
        busy={renameBusy}
        error={renameError}
        confirmDisabled={!draft.trim()}
        onConfirm={rename}
      >
        <TextInput
          aria-label="Device name"
          maxLength={80}
          value={draft}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim() && !renameBusy) void rename();
          }}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={revoking ? `Revoke ${revoking.name}?` : "Revoke device"}
        confirmLabel="Revoke device"
        busy={revokeBusy}
        error={revokeError}
        onConfirm={revoke}
      >
        <p className="text-sm">
          Its credential stops working immediately and its push subscription is removed. To use it
          again, sign in on it again.
        </p>
        {revoking && clients.some((x) => x.deviceId === revoking.id) && (
          <p className="text-sm">The herdr and tmux sessions signed in with it stop updating.</p>
        )}
        {revoking?.id === thisId && (
          <p className="text-sm font-medium text-danger">
            This is the device you are using now. Revoking it signs you out here.
          </p>
        )}
      </ConfirmDialog>
    </SectionPage>
  );
}
