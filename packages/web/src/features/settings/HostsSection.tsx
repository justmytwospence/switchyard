import { CAPABILITY_KEYS, type CapabilityKey, type Host } from "@switchyard/protocol";
import { ChevronRight, CircleCheck, CircleSlash, Plus, Server, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { StatusChip } from "../../components/ui/StatusChip";
import {
  EmptyState,
  HostUnavailable,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative, formatTime } from "../../lib/time";
import { apiPost } from "../../sync/api";
import { useHosts, useSyncStore } from "../../sync/store";
import { AdapterStatus } from "./AdaptersSection";
import {
  createEnrollment,
  type Enrollment,
  EnrollmentStatus,
  ExpiryCountdown,
} from "./EnrollmentPanel";
import {
  Card,
  ConfirmDialog,
  CopyBlock,
  KeyValues,
  LastKnownNote,
  PiCompat,
  PLATFORM_LABEL,
  SectionPage,
  settingsPath,
  useHydrated,
} from "./shared";

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  prompt: "Prompt",
  steer: "Steer a running turn",
  followUp: "Queue follow-up",
  abort: "Abort",
  resume: "Resume",
  rename: "Rename session",
  importInactive: "Import inactive sessions",
  extensionDialogs: "Extension dialogs",
  customUi: "Custom extension UI",
  widgetsText: "Text widgets",
  widgetsComponent: "Component widgets",
  tokenAccounting: "Token accounting",
  costAccounting: "Cost accounting",
};

/** Settings › Hosts. */
export function HostsSection() {
  const hydrated = useHydrated();
  const hosts = useHosts();
  const [adding, setAdding] = useState(false);
  const unavailable = hosts.filter((h) => h.connectivity !== "connected");
  return (
    <SectionPage
      testId="settings-hosts"
      title="Hosts"
      description="Machines that run Pi sessions through the Switchyard host agent."
      actions={
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => setAdding(true)}
        >
          Add host
        </Button>
      }
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading hosts…" />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={<Server className="size-8" />}
          title="No hosts yet"
          description="Add a host to run Pi sessions. You will get a command to run on that machine."
          action={{ label: "Add host", onClick: () => setAdding(true) }}
        />
      ) : (
        <>
          {unavailable.map((h) => (
            <HostUnavailable
              key={h.id}
              compact
              hostName={h.name}
              connectivity={h.connectivity === "reconnecting" ? "reconnecting" : "unreachable"}
              lastSeenAt={h.lastSeenAt}
            />
          ))}
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {hosts.map((h) => (
              <li key={h.id} className="border-b border-border last:border-b-0">
                <HostRow host={h} />
              </li>
            ))}
          </ul>
        </>
      )}
      <AddHostDialog open={adding} onClose={() => setAdding(false)} />
    </SectionPage>
  );
}

function HostRow({ host }: { host: Host }) {
  return (
    <Link
      to={settingsPath(`hosts/${encodeURIComponent(host.id)}`)}
      className="tap flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-surface-2"
    >
      <Server aria-hidden className="size-5 shrink-0 text-muted" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-medium">{host.name}</span>
          <span className="text-sm text-muted">{PLATFORM_LABEL[host.platform]}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusChip kind="host" value={host.connectivity} />
          <PiCompat host={host} />
          <span className="text-xs text-muted">Last seen {formatRelative(host.lastSeenAt)}</span>
        </span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
    </Link>
  );
}

export const NPM_PACKAGE = "@justmytwospence/switchyard";

/** Install, enroll and run as a service: what a new host needs, in order. */
export function hostSetupScript(enrollCommand: string): string {
  return [`npm install -g ${NPM_PACKAGE}`, enrollCommand, "switchyard host install-service"].join(
    "\n",
  );
}

/** "Add host": a single-use enrollment with the command to run on the host. */
function AddHostDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await createEnrollment("host"));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setEnrollment(null);
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add host"
      description="Enroll a machine that runs Pi. Provider credentials stay on that machine."
      footer={<Button onClick={close}>Done</Button>}
    >
      <div className="flex flex-col gap-3">
        {!enrollment && !busy && !error && (
          <>
            <p className="text-sm">
              Create a single-use enrollment, then run the command it shows on the new host. The
              host appears here once its agent connects.
            </p>
            <Button variant="primary" onClick={create}>
              Create enrollment command
            </Button>
          </>
        )}
        <EnrollmentStatus busy={busy} error={error} onRetry={create} />
        {enrollment && !busy && (
          <>
            <p className="text-sm">
              Run this on the host, as the user that should run Pi (it needs Node 24 or newer, git
              and Pi):
            </p>
            <CopyBlock
              text={enrollment.command ? hostSetupScript(enrollment.command) : enrollment.url}
              label={enrollment.command ? "Host setup commands" : "Host enrollment link"}
              copyLabel="Copy commands"
            />
            <ExpiryCountdown expiresAt={enrollment.expiresAt} onRenew={create} busy={busy} />
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Settings › Hosts › host: capabilities, connectivity, checkouts and versions (spec 15). */
export function HostDetail() {
  const { hostId = "" } = useParams();
  const hydrated = useHydrated();
  const host = useSyncStore((s) => s.hosts[hostId]);
  const adapters = useSyncStore((s) => s.adapters[hostId]);
  const checkoutsById = useSyncStore((s) => s.checkouts);
  const projects = useSyncStore((s) => s.projects);
  const navigate = useNavigate();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>(null);

  const checkouts = useMemo(
    () =>
      Object.values(checkoutsById)
        .filter((c) => c.hostId === hostId)
        .sort((a, b) => a.path.localeCompare(b.path)),
    [checkoutsById, hostId],
  );

  const back = { to: settingsPath("hosts"), label: "Hosts" };
  if (!hydrated)
    return (
      <SectionPage title="Host" back={back}>
        <LoadingState label="Loading host…" />
      </SectionPage>
    );
  if (!host || host.revokedAt) {
    return (
      <SectionPage title="Host" back={back}>
        <EmptyState
          icon={<Server className="size-8" />}
          title={host ? "This host was revoked" : "Host not found"}
          description={
            host
              ? `${host.name} was revoked ${formatRelative(host.revokedAt)}. Add it again to use it.`
              : "It may have been revoked or never enrolled with this coordinator."
          }
          action={{ label: "Back to hosts", to: settingsPath("hosts") }}
        />
      </SectionPage>
    );
  }

  const revoke = async () => {
    setRevoking(true);
    setRevokeError(null);
    try {
      await apiPost(`/api/hosts/${encodeURIComponent(host.id)}/revoke`);
      toast.success(`Host ${host.name} revoked`);
      setRevokeOpen(false);
      navigate(settingsPath("hosts"));
    } catch (e) {
      setRevokeError(e);
    } finally {
      setRevoking(false);
    }
  };

  const caps = host.capabilities;
  const reasonFor = (key: string) => caps?.unsupported.find((u) => u.capability === key)?.reason;
  const extraUnsupported =
    caps?.unsupported.filter(
      (u) => !(CAPABILITY_KEYS as readonly string[]).includes(u.capability),
    ) ?? [];

  return (
    <SectionPage
      title={host.name}
      description={`${PLATFORM_LABEL[host.platform]} host`}
      back={back}
      actions={
        <Button
          variant="danger"
          icon={<ShieldOff className="size-4" />}
          onClick={() => {
            setRevokeError(null);
            setRevokeOpen(true);
          }}
        >
          Revoke host
        </Button>
      }
    >
      <LastKnownNote />
      {host.connectivity !== "connected" && (
        <HostUnavailable
          compact
          hostName={host.name}
          connectivity={host.connectivity === "reconnecting" ? "reconnecting" : "unreachable"}
          lastSeenAt={host.lastSeenAt}
        />
      )}

      <Card title="Connectivity and versions">
        <KeyValues
          items={[
            ["Status", <StatusChip key="s" kind="host" value={host.connectivity} />],
            [
              "Last seen",
              host.lastSeenAt
                ? `${formatRelative(host.lastSeenAt)} (${formatTime(host.lastSeenAt)})`
                : "Never",
            ],
            ["Platform", PLATFORM_LABEL[host.platform]],
            [
              "Agent version",
              <span key="a" className="font-mono">
                {host.agentVersion}
              </span>,
            ],
            ["Pi", <PiCompat key="p" host={host} />],
            ["Enrolled", formatTime(host.createdAt)],
          ]}
        />
      </Card>

      <Card
        title="Capabilities"
        description="What Pi on this host supports. Unsupported features are hidden or explained in sessions."
      >
        {!caps ? (
          <UnsupportedCapability
            capability="Capability report"
            reason="This host has not reported its Pi capabilities yet. It may be offline, or Pi may be missing or incompatible."
          />
        ) : (
          <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
            {CAPABILITY_KEYS.map((key) => {
              const ok = caps[key];
              const reason = reasonFor(key);
              return (
                <li key={key} className="flex min-w-0 items-start gap-2 text-sm">
                  {ok ? (
                    <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium">{CAPABILITY_LABELS[key]}</span>
                    <span className="text-muted">: {ok ? "Supported" : "Not supported"}</span>
                    {!ok && reason && (
                      <span className="block break-words text-xs text-muted">{reason}</span>
                    )}
                  </span>
                </li>
              );
            })}
            {extraUnsupported.map((u) => (
              <li key={u.capability} className="flex min-w-0 items-start gap-2 text-sm">
                <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="font-medium break-words">{u.capability}</span>
                  <span className="text-muted">: Not supported</span>
                  <span className="block break-words text-xs text-muted">{u.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Checkout mappings"
        description="Project clones on this host. Sessions and runs for a project use these paths."
      >
        {checkouts.length === 0 ? (
          <EmptyState
            className="py-4"
            title="No checkouts on this host"
            description="Create a project or add a checkout to an existing project."
            action={{ label: "Open projects", to: settingsPath("projects") }}
          />
        ) : (
          <ul className="flex min-w-0 flex-col divide-y divide-border">
            {checkouts.map((c) => (
              <li key={c.id} className="min-w-0 py-2 text-sm">
                <Link
                  to={settingsPath(`projects/${encodeURIComponent(c.projectId)}`)}
                  className="font-medium text-accent hover:underline"
                >
                  {projects[c.projectId]?.name ?? "Unknown project"}
                </Link>
                <div className="break-all font-mono text-xs">{c.path}</div>
                <div className="text-xs text-muted">Default branch: {c.defaultBranch}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Adapters"
        actions={
          <Link to={settingsPath("adapters")} className="text-sm font-medium text-accent">
            All adapters
          </Link>
        }
      >
        {!adapters || adapters.length === 0 ? (
          <p className="text-sm text-muted">No adapters reported by this host.</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {adapters.map((a) => (
              <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="break-all font-mono">{a.id}</span>
                <span className="text-muted">{a.version}</span>
                <AdapterStatus status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        title={`Revoke ${host.name}?`}
        confirmLabel="Revoke host"
        busy={revoking}
        error={revokeError}
        onConfirm={revoke}
      >
        <p className="text-sm">
          The host agent is disconnected and its credential stops working. Sessions on it are not
          moved or restarted elsewhere. To use this machine again, add it as a new host.
        </p>
      </ConfirmDialog>
    </SectionPage>
  );
}
