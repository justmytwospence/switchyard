import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import type { AuthMethods, Passkey } from "@switchyard/protocol";
import { CircleCheck, KeyRound, LogOut, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { signOut } from "../../app/auth";
import { usePasskeyCeremony } from "../../app/passkeyCeremony";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, fieldControlProps } from "../../components/ui/Field";
import { ConfirmDialog, Dialog } from "../../components/ui/Overlay";
import { Spinner } from "../../components/ui/Spinner";
import { InlineStatus } from "../../components/ui/StatusChip";
import { ErrorState, InlineError, LastKnownNote, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { useApiResource } from "../../lib/useResource";
import { apiDelete, apiPost, errorMessage } from "../../sync/api";
import { defaultDeviceName } from "../enroll/logic";
import { isAuthMethods, KeyValues, SectionPage } from "./shared";

/** Settings › Sign-in: passkeys, single sign-on status and signing out of this device. */
export function SignInSection() {
  const methods = useApiResource<AuthMethods>("/api/auth/methods", isAuthMethods);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<unknown>(null);

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await apiDelete(`/api/auth/passkeys/${encodeURIComponent(removing.id)}`);
      toast.success(`Passkey ${removing.name} removed`);
      setRemoving(null);
      methods.reload();
    } catch (e) {
      setRemoveError(e);
    } finally {
      setRemoveBusy(false);
    }
  };

  const doSignOut = async () => {
    setSignOutBusy(true);
    setSignOutError(null);
    try {
      await apiPost("/api/logout");
      setSigningOut(false);
      signOut(null);
    } catch (e) {
      setSignOutError(e);
    } finally {
      setSignOutBusy(false);
    }
  };

  const data = methods.data;
  const availability = data?.passkeyAvailability;
  const supported = browserSupportsWebAuthn();
  const blockReason = !data
    ? null
    : !availability?.available
      ? (availability?.reason ?? "Passkeys are not available on this server.")
      : !supported
        ? "This browser does not support passkeys."
        : null;

  return (
    <SectionPage
      testId="settings-signin"
      title="Sign-in"
      description="How you sign in to Switchyard on new devices. Each signed-in device keeps its own revocable credential."
    >
      <LastKnownNote />
      {methods.loading && !data ? (
        <LoadingState label="Loading sign-in methods…" />
      ) : methods.error && !data ? (
        <ErrorState
          title="Could not load sign-in methods"
          error={methods.error}
          onRetry={methods.reload}
        />
      ) : data ? (
        <>
          <Card
            title="Passkeys"
            description="Sign in on any device with its fingerprint, face or screen lock. Passkeys are stored on this server only as public keys."
            actions={
              <Button
                data-testid="passkey-add"
                variant="primary"
                icon={<Plus className="size-4" />}
                disabled={blockReason !== null}
                onClick={() => setAdding(true)}
              >
                Add a passkey
              </Button>
            }
          >
            {blockReason && (
              <p
                role="status"
                className="mb-3 flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm"
              >
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">
                  Adding a passkey is unavailable: {blockReason}
                </span>
              </p>
            )}
            {data.passkeys.length === 0 ? (
              <p className="text-sm text-muted">
                No passkeys yet. Add one as a backup to single sign-on, or to sign in without it.
              </p>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-border">
                {data.passkeys.map((p) => (
                  <li
                    key={p.id}
                    data-testid="passkey-row"
                    className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <KeyRound aria-hidden className="size-5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium">{p.name}</div>
                      <div className="flex flex-wrap gap-x-3 text-sm text-muted">
                        <span>Added {formatRelative(p.createdAt)}</span>
                        <span>Last used {formatRelative(p.lastUsedAt)}</span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      icon={<Trash2 className="size-4" />}
                      aria-label={`Remove passkey ${p.name}`}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(p);
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Single sign-on" description="Configured on the server">
            {data.oidc ? (
              <div className="flex flex-col gap-2">
                <KeyValues
                  items={[
                    ["Button label", data.oidc.label],
                    [
                      "Provider",
                      <span key="i" className="break-all">
                        {data.oidc.issuer}
                      </span>,
                    ],
                    ["Allowed account", data.oidc.ownerMatch],
                    [
                      "Status",
                      data.oidc.status === "ready" ? (
                        <InlineStatus key="s" icon={CircleCheck} tone="success" label="Ready" />
                      ) : (
                        <InlineStatus key="s" icon={TriangleAlert} tone="danger" label="Error" />
                      ),
                    ],
                  ]}
                />
                {data.oidc.status === "error" && data.oidc.error && (
                  <p role="alert" className="break-words text-sm text-danger">
                    {data.oidc.error}
                  </p>
                )}
              </div>
            ) : (
              <p data-testid="signin-oidc-status" className="text-sm text-muted">
                Not configured. Set the <code>SWITCHYARD_OIDC_*</code> variables on the server to
                sign in with an identity provider.
              </p>
            )}
          </Card>
        </>
      ) : null}

      <Card
        title="This device"
        description="Signing out removes this device's credential here. Other devices stay signed in; revoke a device in Settings › Devices to cut it off."
      >
        <Button
          icon={<LogOut className="size-4" />}
          onClick={() => {
            setSignOutError(null);
            setSigningOut(true);
          }}
        >
          Sign out of this device
        </Button>
      </Card>

      <AddPasskeyDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          methods.reload();
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove passkey ${removing.name}?` : "Remove passkey"}
        confirmLabel="Remove passkey"
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
      >
        <p className="text-sm">
          Devices already signed in stay signed in. This passkey can no longer sign in new devices.
          {data && data.passkeys.length === 1 && !data.oidc
            ? " It is your only passkey and no single sign-on is set up: afterwards new browsers need switchyard pair run on the server."
            : ""}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={signingOut}
        onClose={() => setSigningOut(false)}
        title="Sign out of this device?"
        confirmLabel="Sign out"
        busy={signOutBusy}
        error={signOutError}
        onConfirm={doSignOut}
      >
        <p className="text-sm">
          You will need single sign-on, a passkey or <code>switchyard pair</code> on the server to
          sign in here again.
        </p>
      </ConfirmDialog>
    </SectionPage>
  );
}

/** Name prompt, then the browser's passkey ceremony, then verify on the coordinator. */
function AddPasskeyDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(() => defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ceremony = usePasskeyCeremony();
  const nameError = name.trim() ? null : "Enter a name for this passkey.";

  const close = () => {
    if (ceremony.waiting) ceremony.cancel();
    else if (busy) return;
    setError(null);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (nameError) return;
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await apiPost<{ challengeId: string; options: unknown }>(
        "/api/auth/passkeys/register/options",
      );
      const result = await ceremony.run(() =>
        startRegistration({
          optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
        }),
      );
      if (!result.ok) {
        setBusy(false);
        return;
      }
      const response = result.value;
      await apiPost("/api/auth/passkeys/register/verify", {
        challengeId,
        name: name.trim().slice(0, 80),
        response,
      });
      toast.success("Passkey added");
      onAdded();
    } catch (err) {
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? new Error("The passkey prompt was canceled or timed out. Try again.")
          : err instanceof Error
            ? err
            : new Error(errorMessage(err)),
      );
    } finally {
      setBusy(false);
    }
  };
  const formId = `${ids}-form`;
  return (
    <Dialog
      open={open}
      onClose={close}
      dismissOnBackdrop={!busy || ceremony.waiting}
      title="Add a passkey"
      description="Name it after where it is stored, then confirm with your device."
      footer={
        <>
          <Button onClick={close} disabled={busy && !ceremony.waiting}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            Create passkey
          </Button>
        </>
      }
    >
      <form id={formId} className="flex min-w-0 flex-col gap-4" onSubmit={submit} noValidate>
        <Field id={`${ids}-name`} label="Passkey name" error={nameError}>
          <TextInput
            id={`${ids}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            {...fieldControlProps(`${ids}-name`, { error: nameError })}
          />
        </Field>
        {ceremony.waiting && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Waiting for your passkey… Cancel stops it.
          </p>
        )}
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
