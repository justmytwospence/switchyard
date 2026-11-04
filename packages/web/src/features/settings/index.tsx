import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { Link, Route, Routes, useLocation } from "react-router";
import { useBreakpoint } from "../../app/useBreakpoint";
import { EmptyState } from "../../components/ui/states";
import { cn } from "../../lib/cn";
import { useSyncStore } from "../../sync/store";
import { AdaptersSection } from "./AdaptersSection";
import { BackupsSection } from "./BackupsSection";
import { DeviceSection } from "./DeviceSection";
import { DevicesSection } from "./DevicesSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { HostDetail, HostsSection } from "./HostsSection";
import { NotificationsSection } from "./NotificationsSection";
import { ProfilesSection } from "./ProfilesSection";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectCreate, ProjectsSection } from "./ProjectsSection";
import { SignInSection } from "./SignInSection";
import { LastKnownNote, SECTIONS, SectionPage, settingsPath } from "./shared";

/**
 * Settings (spec 15): hosts, devices, projects, Pi profiles, adapters,
 * notifications, backups, diagnostics and this device's preferences.
 * Desktop and compact show a section nav beside the content; mobile shows
 * the section list at /settings and each section as its own page.
 */
export default function SettingsView() {
  const bp = useBreakpoint();
  const mobile = bp === "mobile";
  const routes = (
    <Routes>
      <Route index element={mobile ? <MobileIndex /> : <Overview />} />
      <Route path="hosts" element={<HostsSection />} />
      <Route path="hosts/:hostId" element={<HostDetail />} />
      <Route path="devices" element={<DevicesSection />} />
      <Route path="sign-in" element={<SignInSection />} />
      <Route path="projects" element={<ProjectsSection />} />
      <Route path="projects/new" element={<ProjectCreate />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="profiles" element={<ProfilesSection />} />
      <Route path="adapters" element={<AdaptersSection />} />
      <Route path="notifications" element={<NotificationsSection />} />
      <Route path="backups" element={<BackupsSection />} />
      <Route path="diagnostics" element={<DiagnosticsSection />} />
      <Route path="device" element={<DeviceSection />} />
      <Route path="*" element={<UnknownSection />} />
    </Routes>
  );
  if (mobile) return <div className="min-w-0">{routes}</div>;
  return (
    <div className="flex min-h-full min-w-0">
      <SectionNav compact={bp === "compact"} />
      <div className="min-w-0 flex-1">{routes}</div>
    </div>
  );
}

function useActiveSection(): string | null {
  const { pathname } = useLocation();
  const parts = pathname.split("/");
  const i = parts.indexOf("settings");
  return i >= 0 ? (parts[i + 1] ?? null) || null : null;
}

/** Left section nav (desktop and compact). */
function SectionNav({ compact }: { compact: boolean }) {
  const active = useActiveSection();
  return (
    <div className={cn("shrink-0 border-r border-border", compact ? "w-52" : "w-60")}>
      <nav
        aria-label="Settings sections"
        data-testid="settings-nav"
        className="sticky top-0 flex max-h-dvh flex-col gap-1 overflow-y-auto px-2 py-4"
      >
        <Link
          to={settingsPath()}
          aria-current={active === null ? "page" : undefined}
          className={cn(
            "tap mb-2 rounded-md px-3 py-1 text-base font-semibold",
            active === null ? "bg-accent-soft" : "hover:bg-surface-2",
          )}
        >
          Settings
        </Link>
        <ul className="flex flex-col gap-0.5">
          {SECTIONS.map(({ path, label, icon: Icon }) => {
            const current = active === path;
            return (
              <li key={path}>
                <Link
                  to={settingsPath(path)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "tap flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium",
                    current
                      ? "bg-accent-soft text-text"
                      : "text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** Short live summaries for the overview. */
function useSummaries(): Record<string, string | undefined> {
  const hosts = useSyncStore((s) => s.hosts);
  const devices = useSyncStore((s) => s.devices);
  const projects = useSyncStore((s) => s.projects);
  const profiles = useSyncStore((s) => s.profiles);
  const adapters = useSyncStore((s) => s.adapters);
  const hydrated = useSyncStore((s) => s.hydrated);
  return useMemo(() => {
    if (!hydrated) return {};
    const hs = Object.values(hosts).filter((h) => h.revokedAt === null);
    const connected = hs.filter((h) => h.connectivity === "connected").length;
    const adapterCount = Object.values(adapters).reduce((n, a) => n + a.length, 0);
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return {
      hosts: `${plural(hs.length, "host")}, ${connected} connected`,
      devices: plural(Object.values(devices).filter((d) => d.revokedAt === null).length, "device"),
      projects: plural(Object.keys(projects).length, "project"),
      profiles: plural(Object.keys(profiles).length, "profile"),
      adapters: plural(adapterCount, "adapter"),
    };
  }, [hosts, devices, projects, profiles, adapters, hydrated]);
}

/** Desktop/compact /settings content: an overview of every section. */
function Overview() {
  const summaries = useSummaries();
  return (
    <SectionPage title="Settings" description="Configure Switchyard and check its health.">
      <LastKnownNote />
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {SECTIONS.map(({ path, label, description, icon: Icon }) => (
          <li key={path} className="min-w-0">
            <Link
              to={settingsPath(path)}
              className="tap flex h-full min-w-0 items-start gap-3 rounded-lg border border-border bg-surface p-4 hover:bg-surface-2"
            >
              <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{label}</span>
                <span className="block text-sm text-muted">{description}</span>
                {summaries[path] && (
                  <span className="mt-1 block text-xs text-subtle">{summaries[path]}</span>
                )}
              </span>
              <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />
            </Link>
          </li>
        ))}
      </ul>
    </SectionPage>
  );
}

/** Mobile /settings: the section list, each row opens a sub-page. */
function MobileIndex() {
  const summaries = useSummaries();
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-xl flex-col gap-3 px-4 py-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <LastKnownNote />
      <nav aria-label="Settings sections" data-testid="settings-nav">
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {SECTIONS.map(({ path, label, description, icon: Icon }) => (
            <li key={path} className="border-b border-border last:border-b-0">
              <Link
                to={settingsPath(path)}
                className="tap flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-surface-2"
              >
                <Icon aria-hidden className="size-5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{label}</span>
                  <span className="block truncate text-sm text-muted">
                    {summaries[path] ?? description}
                  </span>
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function UnknownSection() {
  return (
    <EmptyState
      title="Settings page not found"
      description="This link does not match a settings section."
      action={{ label: "Open Settings", to: settingsPath() }}
    />
  );
}
