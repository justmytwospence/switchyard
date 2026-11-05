import type { NotificationSettings } from "@switchyard/protocol";
import {
  Bell,
  BellOff,
  BellRing,
  CircleSlash,
  type LucideIcon,
  Save,
  Send,
  Smartphone,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Field, fieldControlProps } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { SwitchRow } from "../../components/ui/Switch";
import {
  ErrorState,
  FatalError,
  LoadingState,
  UnsupportedCapability,
} from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import {
  currentSubscription,
  isIos,
  isStandalone,
  type PushPermission,
  pushPermission,
  sendTestNotification,
  subscribePush,
  unsubscribePush,
} from "../../push";
import { ApiClientError, apiPatch, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { Card, InlineError, InlineStatus, SectionPage } from "./shared";
import { isObject, useResource } from "./useResource";

const PERMISSION: Record<
  PushPermission,
  { icon: LucideIcon; label: string; tone: Tone; guidance: string }
> = {
  granted: {
    icon: BellRing,
    label: "Allowed",
    tone: "success",
    guidance: "This device can show Switchyard notifications.",
  },
  denied: {
    icon: BellOff,
    label: "Blocked",
    tone: "danger",
    guidance:
      "Notifications are blocked for this site. Allow them in your browser's site settings (or the system notification settings for the Home Screen app), then reload.",
  },
  default: {
    icon: Bell,
    label: "Not requested yet",
    tone: "neutral",
    guidance:
      "Enable notifications to hear about sessions that need input, failed, or are ready for review.",
  },
  unknown: {
    icon: Bell,
    label: "Unknown",
    tone: "neutral",
    guidance: "The browser did not report a permission state. Try enabling notifications.",
  },
  unsupported: {
    icon: CircleSlash,
    label: "Not supported",
    tone: "warning",
    guidance:
      "This browser cannot receive web push here. On iPhone and iPad, add Switchyard to the Home Screen first.",
  },
};

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Accept the settings object directly or wrapped as `{ settings }`. */
function normalizeSettings(v: unknown): NotificationSettings | null {
  const s = isObject(v) && isObject(v.settings) ? v.settings : v;
  if (!isObject(s) || typeof s.privatePreviews !== "boolean") return null;
  return {
    quietHours: isObject(s.quietHours)
      ? (s.quietHours as NotificationSettings["quietHours"])
      : null,
    privatePreviews: s.privatePreviews,
    preferredDeviceId: typeof s.preferredDeviceId === "string" ? s.preferredDeviceId : null,
  };
}

/** Settings › Notifications (spec 16). */
export function NotificationsSection() {
  const [permission, setPermission] = useState<PushPermission>(() => pushPermission());
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"enable" | "disable" | "test" | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const iosNeedsInstall = isIos() && !isStandalone();

  useEffect(() => {
    let alive = true;
    currentSubscription()
      .then((s) => alive && setSubscribed(s !== null))
      .catch(() => alive && setSubscribed(false));
    const onVisible = () => {
      if (document.visibilityState === "visible") setPermission(pushPermission());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Must stay synchronous up to subscribePush(): the permission prompt needs the user gesture.
  const enable = () => {
    setBusy("enable");
    setActionError(null);
    subscribePush()
      .then((p) => {
        setPermission(p);
        if (p === "granted") {
          setSubscribed(true);
          toast.success("Notifications enabled on this device");
        } else if (p === "denied") {
          toast.error("Notifications were blocked. Allow them in your browser settings.");
        }
      })
      .catch((e) => {
        setActionError(e);
        setPermission(pushPermission());
      })
      .finally(() => setBusy(null));
  };

  const disable = async () => {
    setBusy("disable");
    setActionError(null);
    try {
      await unsubscribePush();
      setSubscribed(false);
      toast.success("Notifications disabled on this device");
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setActionError(null);
    try {
      await sendTestNotification();
      toast.success("Test notification sent. It can take a few seconds to arrive.");
    } catch (e) {
      setActionError(e);
      toast.error(`Test notification failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const p = PERMISSION[permission] ?? PERMISSION.unknown;

  return (
    <SectionPage
      testId="settings-notifications"
      title="Notifications"
      description="Push notifications for sessions that need input, failed, or are ready for review."
    >
      <Card title="This device">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Permission:</span>
            <InlineStatus icon={p.icon} label={p.label} tone={p.tone} />
            {subscribed !== null && permission === "granted" && (
              <span className="text-muted">
                {subscribed ? "Subscribed to push" : "Not subscribed to push"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted">{p.guidance}</p>

          {iosNeedsInstall && (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-sm">
              <p className="mb-2 flex items-center gap-2 font-medium">
                <Smartphone aria-hidden className="size-4 shrink-0" />
                On iPhone and iPad, notifications need the Home Screen app
              </p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>Tap Share</li>
                <li>Add to Home Screen</li>
                <li>Open Switchyard from the Home Screen</li>
                <li>Enable notifications here</li>
              </ol>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {permission !== "unsupported" && !(permission === "granted" && subscribed) && (
              <Button
                variant="primary"
                icon={<BellRing className="size-4" />}
                busy={busy === "enable"}
                disabled={busy !== null && busy !== "enable"}
                onClick={enable}
              >
                Enable notifications
              </Button>
            )}
            {subscribed && (
              <Button
                icon={<BellOff className="size-4" />}
                busy={busy === "disable"}
                disabled={busy !== null && busy !== "disable"}
                onClick={disable}
              >
                Disable on this device
              </Button>
            )}
            <Button
              icon={<Send className="size-4" />}
              busy={busy === "test"}
              disabled={busy !== null && busy !== "test"}
              onClick={test}
            >
              Send test notification
            </Button>
          </div>
          {permission === "unsupported" && (
            <p className="text-xs text-muted">
              Enabling is not possible in this browser. A test notification still goes to your other
              subscribed devices.
            </p>
          )}
          <InlineError error={actionError} />
          <p className="text-sm text-muted">
            Delivery and clearing are best effort: browsers and operating systems may delay, group
            or keep notifications even after you answer elsewhere.
          </p>
        </div>
      </Card>

      <PreferencesCard />
    </SectionPage>
  );
}

function PreferencesCard() {
  const res = useResource<unknown>("/api/me/notification-settings", (v) => !!normalizeSettings(v));
  const settings = useMemo(() => (res.data ? normalizeSettings(res.data) : null), [res.data]);
  const notFound = res.error instanceof ApiClientError && res.error.status === 404;

  return (
    <Card
      title="Delivery preferences"
      description="Shared by all your devices. Attention items in Switchyard are unaffected."
    >
      {notFound ? (
        <UnsupportedCapability
          capability="Notification settings"
          reason="This coordinator does not expose notification settings yet"
        />
      ) : res.fatal ? (
        <FatalError error={res.error} />
      ) : res.error && !settings ? (
        <ErrorState
          compact
          title="Could not load notification settings"
          error={res.error}
          onRetry={res.reload}
        />
      ) : !settings ? (
        <LoadingState label="Loading notification settings…" />
      ) : (
        <PreferencesForm settings={settings} onSaved={(s) => res.setData(s)} />
      )}
    </Card>
  );
}

const TIME_RE = /^\d{2}:\d{2}$/;

function PreferencesForm({
  settings,
  onSaved,
}: {
  settings: NotificationSettings;
  onSaved: (s: NotificationSettings) => void;
}) {
  const ids = useId();
  const devicesById = useSyncStore((s) => s.devices);
  const devices = useMemo(
    () =>
      Object.values(devicesById)
        .filter((d) => d.revokedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [devicesById],
  );
  const [quiet, setQuiet] = useState(settings.quietHours !== null);
  const [start, setStart] = useState(settings.quietHours?.start ?? "22:00");
  const [end, setEnd] = useState(settings.quietHours?.end ?? "07:00");
  const [timezone, setTimezone] = useState(settings.quietHours?.timezone ?? defaultTimezone());
  const [privatePreviews, setPrivatePreviews] = useState(settings.privatePreviews);
  const [preferred, setPreferred] = useState(settings.preferredDeviceId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const startError = quiet && !TIME_RE.test(start) ? "Use a time like 22:00." : null;
  const endError = quiet && !TIME_RE.test(end) ? "Use a time like 07:00." : null;
  const tzError = quiet && !timezone.trim() ? "Enter a time zone, e.g. Europe/Berlin." : null;
  const preferredKnown = !preferred || devices.some((d) => d.id === preferred);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (startError || endError || tzError) return;
    const body: NotificationSettings = {
      quietHours: quiet ? { start, end, timezone: timezone.trim() } : null,
      privatePreviews,
      preferredDeviceId: preferred || null,
    };
    setBusy(true);
    setError(null);
    try {
      const res = await apiPatch<unknown>("/api/me/notification-settings", body);
      onSaved(normalizeSettings(res) ?? body);
      toast.success("Notification preferences saved");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex min-w-0 flex-col gap-4" onSubmit={save} noValidate>
      <SwitchRow
        label="Quiet hours"
        description="No push notifications during these hours. Attention items still collect in Switchyard."
        checked={quiet}
        onChange={setQuiet}
      />
      {quiet && (
        <div className="grid min-w-0 gap-4 sm:grid-cols-3">
          <Field id={`${ids}-start`} label="From" error={startError}>
            <TextInput
              id={`${ids}-start`}
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              {...fieldControlProps(`${ids}-start`, { error: startError })}
            />
          </Field>
          <Field id={`${ids}-end`} label="Until" error={endError}>
            <TextInput
              id={`${ids}-end`}
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              {...fieldControlProps(`${ids}-end`, { error: endError })}
            />
          </Field>
          <Field id={`${ids}-tz`} label="Time zone" error={tzError}>
            <TextInput
              id={`${ids}-tz`}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
              {...fieldControlProps(`${ids}-tz`, { error: tzError })}
            />
          </Field>
        </div>
      )}
      <SwitchRow
        label="Private previews"
        description="Hide task and session text in notifications; show only the status, e.g. Needs input."
        checked={privatePreviews}
        onChange={setPrivatePreviews}
      />
      <Field
        id={`${ids}-device`}
        label="Preferred device"
        hint="Receives push when no desktop was recently active."
      >
        <Select
          id={`${ids}-device`}
          value={preferred}
          onChange={(e) => setPreferred(e.target.value)}
          {...fieldControlProps(`${ids}-device`, { hint: true })}
        >
          <option value="">Automatic (the preferred mobile device)</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.push.subscribed ? "" : " (no push subscription)"}
            </option>
          ))}
          {!preferredKnown && <option value={preferred}>Unknown device ({preferred})</option>}
        </Select>
      </Field>
      <InlineError error={error} />
      <div>
        <Button type="submit" variant="primary" busy={busy} icon={<Save className="size-4" />}>
          Save preferences
        </Button>
      </div>
    </form>
  );
}
