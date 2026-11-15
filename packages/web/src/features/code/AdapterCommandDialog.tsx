import type { Panel } from "@switchyard/protocol";
import { useState } from "react";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { errorMessage } from "../../sync/api";
import { useContributions, useSyncStore } from "../../sync/store";
import { adapterCommandFingerprint } from "./adapterIdentity";
import { codeApi } from "./api";

export type AdapterCommandRequest = { panel: Panel; source: "palette" | "slash"; draft?: string };

export function AdapterCommandDialog({
  request,
  onClose,
  onSuccess,
  activeSessionId,
}: {
  request: AdapterCommandRequest | null;
  activeSessionId?: string | null;
  onClose: () => void;
  onSuccess?: (request: AdapterCommandRequest) => void;
}) {
  const panels = useContributions(request?.panel.sessionId);
  const session = useSyncStore((s) => (request ? s.sessions[request.panel.sessionId] : undefined));
  const host = useSyncStore((s) => (session ? s.hosts[session.hostId] : undefined));
  const unavailable =
    !session ||
    !!session.readOnly ||
    !!session.archivedAt ||
    !host ||
    host.connectivity !== "connected";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = request?.panel;
  const current =
    panel && panels.find((p) => p.adapterId === panel.adapterId && p.slot === panel.slot);
  const changed =
    !!panel &&
    ((activeSessionId !== undefined && activeSessionId !== panel.sessionId) ||
      !current ||
      adapterCommandFingerprint(current) !== adapterCommandFingerprint(panel));
  const close = () => {
    if (!busy) {
      setError(null);
      onClose();
    }
  };
  const run = async (payload: unknown) => {
    if (!request || !panel?.contribution?.actionId || busy || changed || unavailable) return;
    setBusy(true);
    setError(null);
    try {
      await codeApi.adapterAction(
        panel.sessionId,
        panel.adapterId,
        panel.contribution.actionId,
        payload,
      );
      onSuccess?.(request);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!request}
      onClose={close}
      title={panel?.title ?? "Adapter command"}
      description={panel ? `Extension: ${panel.adapterId}` : undefined}
    >
      {changed ? (
        <p role="alert" className="text-sm text-danger">
          This adapter command changed; open it again.
        </p>
      ) : panel?.node && request?.source === "slash" ? (
        <UINodeRenderer
          key={adapterCommandFingerprint(panel)}
          node={panel.node}
          busy={busy}
          disabled={unavailable}
          onRespond={(response) => {
            if (response.kind === "cancel") close();
            else if (response.kind === "form") void run({ ...response, source: "slash" });
          }}
        />
      ) : panel?.node ? (
        <>
          <UINodeRenderer node={panel.node} disabled />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={unavailable}
              onClick={() => void run({ kind: "command", source: "palette" })}
            >
              Run
            </Button>
          </div>
        </>
      ) : null}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
