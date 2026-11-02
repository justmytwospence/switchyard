import { KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { checkAuth, takeReturnTo, useAuth } from "../../app/auth";
import { Button } from "../../components/ui/Button";
import { LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { isStandalone } from "../../push";
import { apiPost, isApiError } from "../../sync/api";

/** A readable default device name from the user agent, e.g. "Safari on iPhone". */
export function defaultDeviceName(ua: string = navigator.userAgent): string {
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${device}`;
}

function readToken(): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  return hash.get("token") ?? query.get("token");
}

const ERROR_TEXT: Record<string, string> = {
  enrollment_expired:
    "This enrollment link has expired. Links are valid for 10 minutes. Create a new one from Settings › Devices › Add device on an enrolled device, or run `switchyard pair` on the server.",
  enrollment_used:
    "This enrollment link was already used. Each link enrolls one device. Create a new one from Settings › Devices › Add device, or run `switchyard pair`.",
  invalid_request: "The enrollment request was rejected. Check the device name and try again.",
  network: "Could not reach the coordinator. Check your connection and try again.",
};

/**
 * /enroll: redeem a single-use enrollment token from `#token=`, name this
 * device, then return to the deep link that required authentication.
 */
export default function EnrollView() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const token = useMemo(readToken, []);
  const status = useAuth((s) => s.status);
  const signedOutReason = useAuth((s) => s.signedOutReason);
  const [name, setName] = useState(() => defaultDeviceName());
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
    if (!token || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/enroll", {
        token,
        name: name.trim().slice(0, 80),
        kind: isStandalone() ? "pwa" : "browser",
      });
      const result = await checkAuth();
      if (result === "authenticated") navigate(takeReturnTo(next), { replace: true });
      else
        setError({
          code: "internal",
          message: "Enrolled, but the coordinator did not accept the new credential. Try again.",
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
            <p className="text-sm text-muted">Enroll this device</p>
          </div>
        </div>
        {signedOutReason && (
          <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm">
            {signedOutReason}
          </p>
        )}
        {token ? (
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="device-name" className="text-sm font-medium">
                Device name
              </label>
              <TextInput
                id="device-name"
                value={name}
                maxLength={80}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                aria-describedby="device-name-hint"
              />
              <p id="device-name-hint" className="text-xs text-muted">
                Shown in Settings › Devices, where you can revoke it later.
              </p>
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-md border border-border bg-danger-soft px-3 py-2 text-sm"
              >
                <div className="font-medium">
                  {error.code === "enrollment_expired"
                    ? "Enrollment link expired"
                    : error.code === "enrollment_used"
                      ? "Enrollment link already used"
                      : "Enrollment failed"}
                </div>
                <div className="text-muted">{error.message}</div>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={
                !name.trim() ||
                error?.code === "enrollment_expired" ||
                error?.code === "enrollment_used"
              }
              icon={<KeyRound className="size-4" />}
            >
              Enroll device
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">This device is not enrolled.</p>
            <p className="text-muted">
              Open an enrollment link or scan its QR code. Create one from Settings › Devices › Add
              device on an enrolled device, or run <code>switchyard pair</code> on the server.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
