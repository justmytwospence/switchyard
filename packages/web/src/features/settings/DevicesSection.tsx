import type { Device } from "@switchyard/protocol";
import {
  BellOff,
  BellRing,
  Laptop,
  MonitorSmartphone,
  Pencil,
  ShieldOff,
  Smartphone,
  Star,
  Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { currentDeviceId, useAuth } from "../../app/auth";
import { Button } from "../../components/ui/Button";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiPatch, apiPost, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { ConfirmDialog, InlineStatus, LastKnownNote, SectionPage, useHydrated } from "./shared";

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

/** Settings › Devices. */
export function DevicesSection() {
  const hydrated = useHydrated();
  const devicesById = useSyncStore((s) => s.devices);
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
      testId="settings-devices"
      title="Devices"
      description="Browsers, Home Screen apps and terminals signed in to this coordinator. Revoke one to sign it out."
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading devices…" />
      ) : devices.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone className="size-8" />}
          title="No devices"
          description="Browsers and terminals appear here once they sign in."
        />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {devices.map((d) => {
            const isThis = d.id === thisId;
            return (
              <li
                key={d.id}
                className="flex min-w-0 flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <KindIcon kind={d.kind} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
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
                    <span className="inline-flex items-center gap-1">
                      {d.push.subscribed ? (
                        <BellRing aria-hidden className="size-4 shrink-0" />
                      ) : (
                        <BellOff aria-hidden className="size-4 shrink-0" />
                      )}
                      {d.push.subscribed ? "Push subscribed" : "No push subscription"}, permission{" "}
                      {PERMISSION_LABEL[d.push.permission]}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!d.preferredMobile && (
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
      )}
      <p className="text-sm text-muted">
        The preferred mobile device receives push notifications when no desktop was recently active.
      </p>

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
          again, add it with a new link.
        </p>
        {revoking?.id === thisId && (
          <p className="text-sm font-medium text-danger">
            This is the device you are using now. Revoking it signs you out here.
          </p>
        )}
      </ConfirmDialog>
    </SectionPage>
  );
}
