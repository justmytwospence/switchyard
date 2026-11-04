import type { Session } from "@switchyard/protocol";
import { Dialog } from "../../components/ui/Overlay";
import { formatTime } from "../../lib/time";
import { contextMeter } from "./model";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-all">{value}</dd>
    </>
  );
}

export interface SessionInfoDialogProps {
  session: Session;
  hostLabel: string;
  open: boolean;
  onClose: () => void;
}

/** Native session information plus token, cost and context stats. */
export function SessionInfoDialog({ session, hostLabel, open, onClose }: SessionInfoDialogProps) {
  const meter = contextMeter(session);
  const stats = session.stats;
  return (
    <Dialog open={open} onClose={onClose} title="Native session information">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <InfoRow label="Switchyard session" value={session.id} />
        <InfoRow label="Pi session id" value={session.nativeHandle?.sessionId ?? "Not started"} />
        <InfoRow label="Session file" value={session.nativeHandle?.sessionFile ?? "None yet"} />
        <InfoRow label="Host" value={hostLabel} />
        <InfoRow label="Working directory" value={session.cwd} />
        <InfoRow label="Origin" value={session.provenance} />
        <InfoRow label="Profile" value={session.profileSnapshot.name} />
        <InfoRow label="Created" value={formatTime(session.createdAt)} />
        {stats?.tokens != null && (
          <InfoRow label="Tokens" value={stats.tokens.toLocaleString("en-US")} />
        )}
        {stats?.costUsd != null && <InfoRow label="Cost" value={`$${stats.costUsd.toFixed(2)}`} />}
        {meter && <InfoRow label="Context" value={`${meter.label} (${meter.detail})`} />}
      </dl>
    </Dialog>
  );
}
