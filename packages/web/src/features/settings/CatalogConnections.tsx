import type { CatalogAccountType, CatalogConnectionStatus, Project } from "@switchyard/protocol";
import { RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../../app/auth";
import { Button, buttonClasses } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field } from "../../components/ui/Field";
import { ConfirmDialog } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import { InlineError, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { formatRelative, formatTime } from "../../lib/time";
import { apiGet, apiPost, isApiError } from "../../sync/api";
import { takeCatalogReturn } from "./catalogReturn";
import { SectionPage, settingsPath } from "./shared";

const CONNECTIONS = "/api/catalog/connections";
const PROJECTS = settingsPath("projects");
export const CATALOG_CONNECT_PATH = settingsPath("projects/connect");
const back = { to: PROJECTS, label: "Projects" };

interface CatalogConflict {
  connectionId: string;
  externalId: string;
  fullName: string;
  projectIds: string[];
}
interface CatalogInventory {
  available: boolean;
  connections: CatalogConnectionStatus[];
  conflicts: CatalogConflict[];
}
interface RegistrationForm {
  url: string;
  fields: Record<string, string>;
}

function providerUrl(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.href;
  } catch {
    // An unavailable or invalid connector action is not a navigation target.
  }
}

export function useCatalogConnections() {
  const [inventory, setInventory] = useState<CatalogInventory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a manual or scheduled reload restarts this read
  useEffect(() => {
    const load = new AbortController();
    apiGet<CatalogInventory>(CONNECTIONS, undefined, load.signal).then(
      (value) => {
        if (load.signal.aborted) return;
        setInventory(value);
        setError(null);
      },
      (e) => {
        if (load.signal.aborted) return;
        if (isApiError(e) && (e.status === 404 || e.code === "unsupported_capability")) {
          setInventory({ available: false, connections: [], conflicts: [] });
          setError(null);
        } else setError(e);
      },
    );
    return () => load.abort();
  }, [revision]);
  useEffect(() => {
    const timer = window.setInterval(() => setRevision((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return { inventory, error, reload: () => setRevision((n) => n + 1) };
}

const statusCopy: Record<CatalogConnectionStatus["state"], string> = {
  pending: "Waiting for installation or organization approval",
  ready: "Connected",
  stale: "Sync failed. Showing the last known repositories.",
  suspended: "Installation suspended. Check its status on GitHub.",
  removed: "Installation removed on GitHub",
  disconnected: "Disconnected from Switchyard",
};

export function CatalogConnections({
  catalog: { inventory, error, reload },
  projects,
}: {
  catalog: ReturnType<typeof useCatalogConnections>;
  projects: Project[];
}) {
  if (!inventory && !error) return <LoadingState label="Loading repository connections…" />;
  return (
    <Card
      title="Repository connections"
      description="Choose which repositories to share on GitHub. No host needs to be online."
    >
      {error != null && (
        <div className="space-y-2">
          <InlineError error={error} />
          <Button size="sm" onClick={reload}>
            Reload connections
          </Button>
        </div>
      )}
      {inventory && !inventory.available && (
        <p className="text-sm text-muted">
          The repository connector is unavailable. Existing projects show the last known catalog.
        </p>
      )}
      {inventory?.available && inventory.connections.length === 0 && (
        <p className="text-sm text-muted">No GitHub accounts connected.</p>
      )}
      {inventory?.connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          available={inventory.available}
          reload={reload}
        />
      ))}
      {inventory?.conflicts.map((conflict) => (
        <HistoryConflict
          key={JSON.stringify([conflict.connectionId, conflict.externalId])}
          conflict={conflict}
          projects={projects}
          disabled={!inventory.available}
          reload={reload}
        />
      ))}
    </Card>
  );
}

function ConnectionRow({
  connection: c,
  available,
  reload,
}: {
  connection: CatalogConnectionStatus;
  available: boolean;
  reload: () => void;
}) {
  const [busy, setBusy] = useState<"refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const disconnected = c.state === "disconnected";
  const install =
    !disconnected && (c.state === "pending" || c.state === "removed")
      ? providerUrl(c.installUrl)
      : undefined;
  const manage = !disconnected ? providerUrl(c.manageUrl) : undefined;

  const mutate = async (action: "refresh" | "disconnect") => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await apiPost(`${CONNECTIONS}/${encodeURIComponent(c.id)}/${action}`);
      if (action === "disconnect") setConfirm(false);
    } catch (e) {
      setError(e);
    } finally {
      reload();
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="break-words text-sm font-medium">
        {c.account} <span className="font-normal text-muted">· {c.accountType}</span>
      </p>
      <p className="text-sm text-muted" role="status">
        {statusCopy[c.state]}
      </p>
      {c.lastSyncedAt && (
        <p className="text-xs text-muted">
          Last synced{" "}
          <time dateTime={c.lastSyncedAt} title={formatTime(c.lastSyncedAt)}>
            {formatRelative(c.lastSyncedAt)}
          </time>
        </p>
      )}
      {c.lastError && <p className="break-words text-sm text-warning">{c.lastError}</p>}
      {install && (
        <p className="text-xs text-muted">
          Install the app, select repositories on GitHub, then return here and refresh.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {install && (
          <TextLink href={install} target="_blank" rel="noopener noreferrer" variant="action">
            Install on GitHub
          </TextLink>
        )}
        {manage && !install && (
          <TextLink href={manage} target="_blank" rel="noopener noreferrer" variant="action">
            Manage repositories on GitHub
          </TextLink>
        )}
        {available && !disconnected && (
          <>
            <Button
              size="sm"
              icon={<RefreshCw className="size-4" />}
              busy={busy === "refresh"}
              disabled={busy === "disconnect"}
              onClick={() => void mutate("refresh")}
            >
              {c.state === "pending" || install ? "Refresh connection" : "Refresh"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              onClick={() => {
                setError(null);
                setConfirm(true);
              }}
            >
              Disconnect
            </Button>
          </>
        )}
      </div>
      {c.lastError?.startsWith("Reconnect provider") && (
        <TextLink to={CATALOG_CONNECT_PATH} variant="action">
          Reconnect provider
        </TextLink>
      )}
      {!confirm && <InlineError error={error} />}
      <ConfirmDialog
        open={confirm}
        title={`Disconnect ${c.account}?`}
        onClose={() => {
          if (!busy) setConfirm(false);
        }}
        onConfirm={() => mutate("disconnect")}
        confirmLabel="Disconnect"
        busy={busy === "disconnect"}
        error={error}
      >
        <p className="text-sm">
          Repositories shared only by this connection will move to Previous projects. Checkouts and
          session history will remain.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function HistoryConflict({
  conflict,
  projects,
  disabled,
  reload,
}: {
  conflict: CatalogConflict;
  projects: Project[];
  disabled: boolean;
  reload: () => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const choices = conflict.projectIds.filter((projectId) =>
    projects.some((p) => p.id === projectId),
  );
  return (
    <form
      className="space-y-2 border-t border-border pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled || !choices.includes(choice)) return;
        setBusy(true);
        setError(null);
        try {
          await apiPost(
            `${CONNECTIONS}/${encodeURIComponent(conflict.connectionId)}/resolve-history`,
            {
              externalId: conflict.externalId,
              projectId: choice,
            },
          );
          reload();
          toast.success("Existing history selected");
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field
        id={id}
        label="Choose existing history"
        hint={`More than one previous project matches ${conflict.fullName}. Choose which history to keep using for this repository. The others remain available separately.`}
      >
        <Select
          id={id}
          value={choices.includes(choice) ? choice : ""}
          disabled={disabled || busy}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Choose a previous project</option>
          {choices.map((projectId) => (
            <option key={projectId} value={projectId}>
              {projects.find((p) => p.id === projectId)?.name} · {projectId}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          type="submit"
          busy={busy}
          disabled={disabled || !choices.includes(choice)}
        >
          Use selected history
        </Button>
        {choices.includes(choice) && (
          <TextLink
            to={settingsPath(`projects/${encodeURIComponent(choice)}`)}
            target="_blank"
            rel="noreferrer"
          >
            View selected project
          </TextLink>
        )}
      </div>
      <InlineError error={error} />
    </form>
  );
}

export function CatalogConnect() {
  const id = useId();
  const [account, setAccount] = useState("");
  const [accountType, setAccountType] = useState<CatalogAccountType>("personal");
  const [registration, setRegistration] = useState<RegistrationForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <SectionPage
      title="Connect GitHub"
      description="Register a private GitHub App for your account, then install it on the repositories you want to see in Switchyard."
      back={back}
    >
      <Card>
        {registration ? (
          <form method="post" action={registration.url} className="space-y-3">
            {Object.entries(registration.fields).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <p className="break-words text-sm">
              Continue to GitHub as {account.trim()} to register the app. You must be able to
              register and install apps for this account.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary">
                Continue to GitHub
              </Button>
              <Button onClick={() => setRegistration(null)}>Change account</Button>
            </div>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !account.trim()) return;
              setBusy(true);
              setError(null);
              try {
                const form = await apiPost<RegistrationForm>(`${CONNECTIONS}/begin`, {
                  account: account.trim(),
                  accountType,
                });
                const url = providerUrl(form.url);
                if (!url) throw new Error("The provider did not return a valid registration form.");
                setRegistration({ url, fields: form.fields });
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field id={`${id}-type`} label="Account type">
              <Select
                id={`${id}-type`}
                value={accountType}
                disabled={busy}
                onChange={(e) =>
                  setAccountType(e.target.value === "organization" ? "organization" : "personal")
                }
              >
                <option value="personal">Personal</option>
                <option value="organization">Organization</option>
              </Select>
            </Field>
            <Field
              id={`${id}-account`}
              label={accountType === "personal" ? "GitHub username" : "GitHub organization"}
            >
              <TextInput
                id={`${id}-account`}
                value={account}
                maxLength={39}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy}
                onChange={(e) => setAccount(e.target.value)}
              />
            </Field>
            <InlineError error={error} />
            <Button type="submit" variant="primary" disabled={!account.trim()} busy={busy}>
              Set up connection
            </Button>
          </form>
        )}
      </Card>
    </SectionPage>
  );
}

export function CatalogConnectReturn() {
  const completion = useRef<Promise<void> | null>(null);
  const authenticated = useAuth((s) => s.status === "authenticated");
  const [result, setResult] = useState<"waiting" | "registered" | "restart">("waiting");
  useEffect(() => {
    if (!authenticated) return;
    if (!completion.current) {
      const proof = takeCatalogReturn();
      if (proof) completion.current = apiPost<void>(`${CONNECTIONS}/complete`, proof);
    }
    if (!completion.current) {
      setResult("restart");
      return;
    }
    let active = true;
    completion.current.then(
      () => {
        if (active) setResult("registered");
      },
      () => {
        if (active) setResult("restart");
      },
    );
    return () => {
      active = false;
    };
  }, [authenticated]);

  return (
    <SectionPage title="Connect GitHub" back={back}>
      {result === "waiting" ? (
        <LoadingState label="Completing registration…" />
      ) : (
        <Card title={result === "registered" ? "GitHub App registered" : "Restart the connection"}>
          <p className="text-sm text-muted">
            {result === "registered"
              ? "Open Projects, choose Install on GitHub, and select the repositories to share. When installation is complete, refresh the connection."
              : "This registration could not be completed. Start again on this device and use the GitHub account you entered."}
          </p>
          <div>
            <Link
              className={buttonClasses("primary")}
              to={result === "registered" ? PROJECTS : CATALOG_CONNECT_PATH}
              replace
            >
              {result === "registered" ? "Open Projects" : "Connect GitHub again"}
            </Link>
          </div>
        </Card>
      )}
    </SectionPage>
  );
}
