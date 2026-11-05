import type { TerminalLoginRequest } from "@switchyard/protocol";
import { Terminal, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "../../components/ui/Button";
import { LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { formatRelative } from "../../lib/time";
import { apiGet, apiPost, errorMessage, isApiError } from "../../sync/api";
import { InlineError } from "../settings/shared";

/** /terminal-login?code=XXXX-XXXX: approve or deny a terminal's `switchyard login`. */
export default function TerminalLoginView() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = params.get("code")?.trim() ?? "";
  const [typed, setTyped] = useState("");
  const [request, setRequest] = useState<TerminalLoginRequest | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (!code) return;
    const ac = new AbortController();
    setRequest(null);
    setNotFound(null);
    setLoadError(null);
    apiGet<TerminalLoginRequest>(
      `/api/auth/terminal/requests/${encodeURIComponent(code)}`,
      undefined,
      ac.signal,
    )
      .then((r) => !ac.signal.aborted && setRequest(r))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        if (isApiError(e) && e.code === "not_found") setNotFound(errorMessage(e));
        else setLoadError(e);
      });
    return () => ac.abort();
  }, [code]);

  const act = async (action: "approve" | "deny") => {
    setBusy(true);
    setActionError(null);
    try {
      setRequest(
        await apiPost<TerminalLoginRequest>(
          `/api/auth/terminal/requests/${encodeURIComponent(code)}/${action}`,
        ),
      );
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (!code) {
    body = (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) navigate(`?code=${encodeURIComponent(typed.trim())}`);
        }}
      >
        <label htmlFor="tl-code" className="text-sm font-medium">
          Code from your terminal
        </label>
        <TextInput
          id="tl-code"
          value={typed}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!typed.trim()}>
          Continue
        </Button>
      </form>
    );
  } else if (notFound) {
    body = (
      <div
        role="alert"
        className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm"
      >
        <div className="flex items-center gap-1.5 font-medium">
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          Sign-in request not found
        </div>
        <div className="text-muted">{notFound}</div>
      </div>
    );
  } else if (loadError) {
    body = <InlineError error={loadError} />;
  } else if (!request) {
    body = <LoadingState label="Loading the sign-in request…" />;
  } else if (request.status === "approved") {
    body = (
      <div role="status" className="flex flex-col gap-3 text-sm">
        <p className="font-medium">
          Terminal signed in. You can close this tab and return to your terminal.
        </p>
        <Link to="/" className="font-medium text-accent underline">
          Back to Switchyard
        </Link>
      </div>
    );
  } else if (request.status === "denied") {
    body = (
      <p role="status" className="text-sm font-medium">
        Sign-in denied. The terminal was not signed in.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-base font-medium">Sign in a terminal?</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-muted">Terminal</dt>
          <dd className="break-words">{request.name}</dd>
          <dt className="text-muted">Code</dt>
          <dd data-testid="terminal-login-code" className="font-mono text-lg tracking-widest">
            {request.userCode}
          </dd>
          <dt className="text-muted">From</dt>
          <dd>{request.requestedFrom}</dd>
          <dt className="text-muted">Requested</dt>
          <dd>{formatRelative(request.createdAt)}</dd>
        </dl>
        <p className="text-muted">
          Approve only if you just ran switchyard login and your terminal shows this code.
        </p>
        <InlineError error={actionError} />
        <div className="flex gap-2">
          <Button
            variant="primary"
            data-testid="terminal-login-approve"
            busy={busy}
            onClick={() => void act("approve")}
          >
            Approve
          </Button>
          <Button
            data-testid="terminal-login-deny"
            disabled={busy}
            onClick={() => void act("deny")}
          >
            Deny
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-start justify-center px-4 safe-pt-10 safe-pb-10 sm:items-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10 rounded-lg" />
          <div>
            <h1 className="text-lg font-semibold">Switchyard</h1>
            <p className="flex items-center gap-1 text-sm text-muted">
              <Terminal aria-hidden className="size-3.5" /> Terminal sign-in
            </p>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}
