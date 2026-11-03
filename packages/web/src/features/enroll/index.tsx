import { startAuthentication } from "@simplewebauthn/browser";
import type { OidcBeginResponse, OidcClaimResponse, SetupState } from "@switchyard/protocol";
import { KeyRound, LogIn, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { checkAuth, takeReturnTo, useAuth } from "../../app/auth";
import { Button } from "../../components/ui/Button";
import { ErrorState, LoadingState } from "../../components/ui/states";
import { isStandalone } from "../../push";
import { apiGet, apiPost, isApiError } from "../../sync/api";
import {
  defaultDeviceName,
  ERROR_TEXT,
  enrollErrorText,
  enrollErrorTitle,
  HANDOFF_POLL_MS,
  type HandoffState,
  handoffReduce,
  shouldPoll,
  startHandoff,
} from "./logic";

export { defaultDeviceName };

function readToken(): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  return hash.get("token") ?? query.get("token");
}

/**
 * /sign-in: redeem a single-use sign-in link token from `#token=`, or (without
 * one) sign in with single sign-on or a passkey, then
 * return to the deep link that required authentication.
 */
export default function EnrollView() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const token = useMemo(readToken, []);
  const status = useAuth((s) => s.status);
  const signedOutReason = useAuth((s) => s.signedOutReason);
  const deviceName = useMemo(() => defaultDeviceName(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  // Keep the token out of the address bar and history.
  useEffect(() => {
    if (token) history.replaceState(history.state, "", location.pathname + location.search);
  }, [token]);

  // Already enrolled and no token: go back to the deep link.
  useEffect(() => {
    if (!token && status === "authenticated") navigate(takeReturnTo(next), { replace: true });
  }, [token, status, next, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/enroll", {
        token,
        name: deviceName.slice(0, 80),
        kind: isStandalone() ? "pwa" : "browser",
      });
      const result = await checkAuth();
      if (result === "authenticated") navigate(takeReturnTo(next), { replace: true });
      else
        setError({
          code: "internal",
          message: "Signed in, but the coordinator did not accept the new credential. Try again.",
        });
    } catch (err) {
      const code = isApiError(err) ? err.code : "internal";
      setError({
        code,
        message: ERROR_TEXT[code] ?? (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setBusy(false);
    }
  };

  if (!token && status === "checking") return <LoadingState label="Checking this device…" />;

  return (
    <div className="flex min-h-dvh items-start justify-center px-4 py-10 safe-pt safe-pb sm:items-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10 rounded-lg" />
          <div>
            <h1 className="text-lg font-semibold">Switchyard</h1>
            <p className="text-sm text-muted">{token ? "Sign in this browser" : "Sign in"}</p>
          </div>
        </div>
        {signedOutReason && (
          <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm">
            {signedOutReason}
          </p>
        )}
        {token ? (
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <p className="text-sm">
              This single-use link signs in this browser as “{deviceName}”. You can rename it in
              Settings › Devices.
            </p>
            {error && (
              <div
                role="alert"
                className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm"
              >
                <div className="font-medium">{enrollErrorTitle(error.code)}</div>
                <div className="text-muted">{error.message}</div>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              data-testid="signin-link"
              busy={busy}
              disabled={error?.code === "enrollment_expired" || error?.code === "enrollment_used"}
              icon={<KeyRound className="size-4" />}
            >
              Sign in
            </Button>
          </form>
        ) : (
          <SignInPanel next={next} />
        )}
      </div>
    </div>
  );
}

interface ChallengeResponse {
  challengeId: string;
  options: unknown;
}

const kindOf = () => (isStandalone() ? "pwa" : "browser");

function AlertBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm">
      <div className="flex items-center gap-1.5 font-medium">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {title}
      </div>
      <div className="break-words text-muted">{children}</div>
    </div>
  );
}

/** The no-token screen: the sign-in options. */
function SignInPanel({ next }: { next: string | null }) {
  const navigate = useNavigate();
  const deviceName = useMemo(() => defaultDeviceName().slice(0, 80), []);
  const [params, setParams] = useSearchParams();
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<"passkey" | "oidc" | null>(null);
  const [notice, setNotice] = useState<{ code: string; message: string } | null>(() => {
    const code = params.get("error");
    return code ? { code, message: enrollErrorText(code, params.get("detail")) } : null;
  });
  const [handoff, setHandoff] = useState<{ flowId: string; pollToken: string } | null>(null);
  const authorizeUrlRef = useRef<string | null>(null);

  // Show a callback error once, then drop it from the address bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount
  useEffect(() => {
    if (!params.has("error") && !params.has("detail")) return;
    const rest = new URLSearchParams(params);
    rest.delete("error");
    rest.delete("detail");
    setParams(rest, { replace: true });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` reloads
  useEffect(() => {
    const ac = new AbortController();
    setLoadError(null);
    apiGet<SetupState>("/api/setup", undefined, ac.signal)
      .then((v) => !ac.signal.aborted && setSetup(v))
      .catch((e: unknown) => !ac.signal.aborted && setLoadError(e));
    return () => ac.abort();
  }, [nonce]);

  const fail = (err: unknown) => {
    const code = isApiError(err) ? err.code : "internal";
    // A cancelled or dismissed WebAuthn prompt is not an error worth shouting about.
    if (err instanceof Error && err.name === "NotAllowedError") {
      setNotice({ code, message: "Passkey sign-in was cancelled or timed out." });
      return;
    }
    setNotice({
      code,
      message: isApiError(err)
        ? enrollErrorText(code, err.message)
        : err instanceof Error
          ? err.message
          : String(err),
    });
  };

  const finish = useCallback(async () => {
    const result = await checkAuth();
    if (result === "authenticated") navigate(takeReturnTo(next), { replace: true });
    else
      setNotice({
        code: "internal",
        message: "Signed in, but the coordinator did not accept the new credential. Try again.",
      });
  }, [navigate, next]);

  const signInWithPasskey = async () => {
    setBusy("passkey");
    setNotice(null);
    try {
      const { challengeId, options } = await apiPost<ChallengeResponse>(
        "/api/auth/passkey/options",
      );
      const response = await startAuthentication({
        optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
      await apiPost("/api/auth/passkey/verify", {
        challengeId,
        response,
        deviceName,
        kind: kindOf(),
      });
      await finish();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const signInWithOidc = async () => {
    setBusy("oidc");
    setNotice(null);
    const standalone = isStandalone();
    try {
      const res = await apiPost<OidcBeginResponse>("/api/auth/oidc/begin", {
        deviceName,
        kind: kindOf(),
        next: takeReturnTo(next),
        handoff: standalone,
      });
      if (standalone && res.flowId && res.pollToken) {
        // Home Screen apps have their own cookie jar: finish in the browser, claim here.
        authorizeUrlRef.current = res.authorizeUrl;
        setHandoff({ flowId: res.flowId, pollToken: res.pollToken });
        window.open(res.authorizeUrl, "_blank");
      } else {
        location.assign(res.authorizeUrl);
        return; // leaving the page; keep the button busy
      }
    } catch (err) {
      fail(err);
    }
    setBusy(null);
  };

  if (loadError) {
    return (
      <ErrorState
        title="Cannot reach Switchyard"
        error={loadError}
        onRetry={() => setNonce((n) => n + 1)}
      />
    );
  }
  if (!setup) return <LoadingState label="Checking this server…" />;

  if (handoff) {
    return (
      <HandoffScreen
        flowId={handoff.flowId}
        pollToken={handoff.pollToken}
        authorizeUrl={authorizeUrlRef.current}
        onDone={finish}
        onExit={() => setHandoff(null)}
      />
    );
  }

  const passkeyReady = setup.passkey.registered && setup.passkey.available;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-base font-medium">Sign in to Switchyard</p>
      {notice && <AlertBox title="Sign-in failed">{notice.message}</AlertBox>}
      <div className="flex flex-col gap-2">
        {setup.oidc && (
          <Button
            data-testid="signin-oidc"
            variant="primary"
            busy={busy === "oidc"}
            disabled={busy !== null}
            icon={<LogIn className="size-4" />}
            onClick={signInWithOidc}
          >
            {setup.oidc.label}
          </Button>
        )}
        {passkeyReady && (
          <Button
            data-testid="signin-passkey"
            variant={setup.oidc ? "secondary" : "primary"}
            busy={busy === "passkey"}
            disabled={busy !== null}
            icon={<KeyRound className="size-4" />}
            onClick={signInWithPasskey}
          >
            Sign in with a passkey
          </Button>
        )}
        {setup.passkey.registered && !setup.passkey.available && setup.passkey.reason && (
          <p className="text-xs text-muted">Passkeys are unavailable: {setup.passkey.reason}.</p>
        )}
      </div>
      {!setup.oidc && !passkeyReady ? (
        <p data-testid="signin-pair-hint" className="text-muted">
          No sign-in method is set up. On the machine running Switchyard, run{" "}
          <code>switchyard pair</code> for a single-use sign-in link.
        </p>
      ) : (
        <p className="text-xs text-muted">
          Locked out? Run <code>switchyard pair</code> on the server for a single-use sign-in link.
        </p>
      )}
    </div>
  );
}

/** PWA single sign-on handoff: finish in the browser, claim the credential here. */
function HandoffScreen({
  flowId,
  pollToken,
  authorizeUrl,
  onDone,
  onExit,
}: {
  flowId: string;
  pollToken: string;
  authorizeUrl: string | null;
  onDone: () => Promise<void>;
  onExit: () => void;
}) {
  const [state, setState] = useState<HandoffState>(() => startHandoff(Date.now()));
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const apply = useCallback((event: Parameters<typeof handoffReduce>[1]) => {
    const next = handoffReduce(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const poll = useCallback(async () => {
    if (inFlight.current || stateRef.current.phase !== "waiting") return;
    inFlight.current = true;
    try {
      const result = await apiPost<OidcClaimResponse>("/api/auth/oidc/claim", {
        flowId,
        pollToken,
      });
      const next = apply({ type: "claim", result, now: Date.now() });
      if (next.phase === "done") await doneRef.current();
    } catch (err) {
      apply({
        type: "claim_error",
        code: isApiError(err) ? err.code : "network",
        message: "This sign-in expired or was already used. Start again.",
        now: Date.now(),
      });
    } finally {
      inFlight.current = false;
    }
  }, [flowId, pollToken, apply]);

  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      apply({ type: "tick", now: Date.now() });
      if (shouldPoll(stateRef.current, visible())) void poll();
    }, HANDOFF_POLL_MS);
    const onVisible = () => {
      if (shouldPoll(stateRef.current, visible())) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll, apply]);

  if (state.phase === "timeout" || state.phase === "failed" || state.phase === "cancelled") {
    return (
      <div data-testid="signin-handoff" className="flex flex-col gap-3 text-sm">
        <AlertBox title={state.phase === "timeout" ? "Sign-in timed out" : "Sign-in stopped"}>
          {state.phase === "timeout"
            ? "The sign-in was not finished in time. Start again."
            : (state.message ?? "Start again.")}
        </AlertBox>
        <Button onClick={onExit}>Back to sign-in</Button>
      </div>
    );
  }
  return (
    <div data-testid="signin-handoff" role="status" className="flex flex-col gap-3 text-sm">
      <p className="font-medium">Finish signing in, then come back here</p>
      <p className="text-muted">
        Complete single sign-on in the page that opened, then return to this app. This screen
        continues on its own.
      </p>
      {authorizeUrl && (
        <a
          href={authorizeUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent underline"
        >
          Open the sign-in page again
        </a>
      )}
      <Button
        onClick={() => {
          apply({ type: "cancel" });
          onExit();
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
