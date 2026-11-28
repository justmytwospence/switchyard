import type { Checkout, Host, Project, Workspace } from "@switchyard/protocol";
import { useId, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, fieldControlProps } from "../../components/ui/Field";
import { InlineError } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { apiPost } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { settingsPath, validateAbsolutePath } from "./shared";

interface CheckoutPreview {
  action: "reuse" | "clone" | "collision";
  path: string;
  previewId?: string;
}

interface PreparedCheckout {
  checkout: Checkout;
  workspaces: Workspace[];
}

export function checkoutFolderProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return "Enter a folder name.";
  if (
    name.length > 128 ||
    name === "." ||
    name === ".." ||
    /^\.git$/i.test(name) ||
    /[/\\]/.test(name) ||
    [...name].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    return "Use one folder name, not a path or .git.";
  }
  return null;
}

export function checkoutPreviewProblem(host: Host, hasCheckout = false): string | null {
  if (host.revokedAt) return `${host.name} was revoked. Enroll it again or choose another host.`;
  if (host.connectivity !== "connected") {
    return `${host.name} is offline. Reconnect it or choose another host.`;
  }
  if (!host.checkoutProvision && !hasCheckout) {
    return "Update this host agent to prepare checkouts, or attach an existing clone.";
  }
  // Preview can reuse a known checkout even if the host has no managed clone destination.
  return null;
}

export function CheckoutPrepare({
  project,
  host,
  hasCheckout,
  attachFallback,
  onBusyChange,
  onPrepared,
}: {
  project: Project;
  host: Host | undefined;
  hasCheckout: boolean;
  attachFallback?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onPrepared?: () => void;
}) {
  const id = useId();
  const [review, setReview] = useState<CheckoutPreview | null>(null);
  const [folder, setFolder] = useState("");
  const [checkedFolder, setCheckedFolder] = useState<string | undefined>();
  const [recoveryPath, setRecoveryPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const running = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [attaching, setAttaching] = useState(false);
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}/checkouts`;

  if (!host) {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">No checkout yet</p>
        <p className="text-muted">
          Choose or connect a host to prepare a checkout.{" "}
          <TextLink to={settingsPath("hosts")} target="_blank" rel="noreferrer" variant="action">
            Open Hosts
          </TextLink>
        </p>
      </div>
    );
  }
  const blocked = checkoutPreviewProblem(host, hasCheckout);
  const noRoot = !hasCheckout && !host.checkoutRoot;
  const folderProblem = folder.trim() ? checkoutFolderProblem(folder) : null;
  const canAttach =
    attachFallback && !host.revokedAt && host.connectivity === "connected" && !recoveryPath;

  const preview = async (folderName?: string) => {
    if (running.current || blocked || (noRoot && !recoveryPath)) return;
    running.current = true;
    setBusy("preview");
    setError(null);
    try {
      const result = await apiPost<CheckoutPreview>(`${endpoint}/preview`, {
        hostId: host.id,
        ...(folderName === undefined ? {} : { folderName }),
      });
      if (recoveryPath && result.path !== recoveryPath) {
        throw new Error(
          "The checkout destination changed. Inspect the original path on the host before preparing a different checkout.",
        );
      }
      setReview(result);
      setCheckedFolder(folderName);
      setRecoveryPath(null);
    } catch (e) {
      setError(e);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  const apply = async () => {
    if (running.current || blocked || !review?.previewId || review.action === "collision") return;
    running.current = true;
    setBusy("apply");
    onBusyChange?.(true);
    setError(null);
    try {
      const result = await apiPost<PreparedCheckout>(`${endpoint}/provision`, {
        previewId: review.previewId,
      });
      useSyncStore.getState().recordPreparedCheckout(result.checkout, result.workspaces);
      setReview(null);
      toast.success("Checkout ready");
      onPrepared?.();
    } catch (e) {
      // A lost response is not evidence that no checkout was made. Never retry a provision
      // directly, even if the coordinator has not yet sent an update for that destination.
      setRecoveryPath(review.path);
      setReview(null);
      setError(e);
    } finally {
      running.current = false;
      onBusyChange?.(false);
      setBusy(null);
    }
  };

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border p-3 text-sm">
      <p className="font-medium">{hasCheckout ? "Prepare checkout" : "No checkout yet"}</p>
      <p className="text-muted">Host: {host.name}</p>
      {blocked && <p className="text-muted">{blocked}</p>}
      {noRoot && (
        <p className="text-muted">
          Set a{" "}
          <TextLink
            to={settingsPath(`hosts/${encodeURIComponent(host.id)}`)}
            target="_blank"
            rel="noreferrer"
          >
            checkout location
          </TextLink>{" "}
          for this host, or attach an existing clone.
        </p>
      )}
      {recoveryPath && (
        <p className="break-words text-muted">
          Check the checkout status at <span className="font-mono">{recoveryPath}</span> before
          trying again.
        </p>
      )}
      <InlineError error={error} />
      {review ? (
        <div className="space-y-2">
          <p className="break-words">
            Destination: <span className="font-mono">{review.path}</span>
          </p>
          {review.action === "collision" ? (
            <>
              <p>Choose another folder. The existing path will not be changed.</p>
              <Field label="Alternative folder name" id={id} error={folderProblem}>
                <TextInput
                  id={id}
                  value={folder}
                  disabled={!!busy}
                  onChange={(e) => setFolder(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  {...fieldControlProps(id, { error: folderProblem })}
                />
              </Field>
              <Button
                disabled={
                  !!blocked ||
                  !!busy ||
                  !folder.trim() ||
                  !!folderProblem ||
                  folder.trim() === checkedFolder
                }
                onClick={() => void preview(folder.trim())}
              >
                Preview this folder
              </Button>
            </>
          ) : review.previewId ? (
            <Button
              variant="primary"
              busy={busy === "apply"}
              disabled={!!blocked}
              onClick={() => void apply()}
            >
              {review.action === "reuse" ? "Use existing checkout" : `Clone to ${host.name}`}
            </Button>
          ) : (
            <p>Cancel this preview and preview again before preparing this checkout.</p>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => {
              setReview(null);
              setFolder("");
              setError(null);
            }}
          >
            Cancel preview
          </Button>
        </div>
      ) : !blocked && (!noRoot || recoveryPath) ? (
        <Button
          busy={busy === "preview"}
          onClick={() => void preview(recoveryPath ? checkedFolder : undefined)}
        >
          {recoveryPath ? "Check checkout status" : "Preview checkout"}
        </Button>
      ) : null}
      {canAttach &&
        (blocked || noRoot || !host.checkoutProvision) &&
        (attaching ? (
          <AttachCheckout
            project={project}
            host={host}
            onBusyChange={onBusyChange}
            onAttached={() => {
              setAttaching(false);
              onPrepared?.();
            }}
          />
        ) : (
          <div>
            <Button onClick={() => setAttaching(true)}>Attach existing checkout</Button>
          </div>
        ))}
    </div>
  );
}

function AttachCheckout({
  project,
  host,
  onBusyChange,
  onAttached,
}: {
  project: Project;
  host: Host;
  onBusyChange?: (busy: boolean) => void;
  onAttached: () => void;
}) {
  const id = useId();
  const running = useRef(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const problem = validateAbsolutePath(path);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (running.current || problem) return;
        running.current = true;
        setBusy(true);
        onBusyChange?.(true);
        setError(null);
        try {
          const result = await apiPost<PreparedCheckout>(
            `/api/projects/${encodeURIComponent(project.id)}/checkouts`,
            {
              hostId: host.id,
              path: path.trim(),
            },
          );
          useSyncStore.getState().recordPreparedCheckout(result.checkout, result.workspaces);
          toast.success("Checkout attached");
          onAttached();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
          onBusyChange?.(false);
          running.current = false;
        }
      }}
    >
      <Field
        id={id}
        label="Checkout path on the host"
        hint="Absolute path to an existing clone of this repository."
      >
        <TextInput
          id={id}
          value={path}
          className="font-mono"
          onChange={(e) => setPath(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          {...fieldControlProps(id, { hint: true })}
        />
      </Field>
      <InlineError error={error} />
      <Button type="submit" busy={busy} disabled={!!problem}>
        Attach checkout
      </Button>
    </form>
  );
}
