import type { Device } from "@switchyard/protocol";
import {
  BellOff,
  BellRing,
  Laptop,
  MonitorSmartphone,
  Plus,
  ShieldOff,
  Smartphone,
  Star,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { currentDeviceId, useAuth } from "../../app/auth";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiPatch, apiPost, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import {
  createEnrollment,
  type Enrollment,
  EnrollmentStatus,
  ExpiryCountdown,
} from "./EnrollmentPanel";
import {
  ConfirmDialog,
  CopyButton,
  InlineStatus,
  LastKnownNote,
  SectionPage,
  useHydrated,
} from "./shared";

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
  const [adding, setAdding] = useState(false);
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

  return (
    <SectionPage
      testId="settings-devices"
      title="Devices"
      description="Browsers, Home Screen apps and terminals signed in to this coordinator. Each has its own revocable credential."
      actions={
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => setAdding(true)}
        >
          Add device
        </Button>
      }
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading devices…" />
      ) : devices.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone className="size-8" />}
          title="No devices"
          description="Add a phone, tablet or another computer with a single-use QR link."
          action={{ label: "Add device", onClick: () => setAdding(true) }}
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

      <AddDeviceDialog open={adding} onClose={() => setAdding(false)} />
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

/** "Add device": single-use QR link with a countdown. */
export function AddDeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await createEnrollment("device"));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // One single-use link per opening of the dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reacts to the dialog opening
  useEffect(() => {
    if (open) void create();
  }, [open]);
  const close = () => {
    setEnrollment(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add device"
      description="Scan the code with the new device's camera, or open the link on it."
      footer={<Button onClick={close}>Done</Button>}
    >
      <div data-testid="add-device-dialog" className="flex min-w-0 flex-col items-stretch gap-3">
        <EnrollmentStatus busy={busy} error={error} onRetry={create} />
        {enrollment && !busy && (
          <>
            {enrollment.qrSvg && (
              <div
                role="img"
                aria-label="QR code for the enrollment link"
                className="mx-auto size-56 max-w-full rounded-md bg-white p-2 [&>svg]:size-full"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG generated by the coordinator from its own enrollment URL
                dangerouslySetInnerHTML={{ __html: enrollment.qrSvg }}
              />
            )}
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <a
                href={enrollment.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 break-all font-mono text-sm text-accent underline"
              >
                {enrollment.url}
              </a>
              <CopyButton text={enrollment.url} label="Copy link" toastMessage="Link copied" />
            </div>
            <ExpiryCountdown expiresAt={enrollment.expiresAt} onRenew={create} busy={busy} />
            <p className="text-xs text-muted">
              Anyone with this link can enroll a device until it expires or is used. Share it only
              with your own devices.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
