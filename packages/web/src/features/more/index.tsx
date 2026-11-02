import { ChevronRight, type LucideIcon, Settings, Timer, Workflow } from "lucide-react";
import { Link } from "react-router";

const ITEMS: { to: string; label: string; description: string; icon: LucideIcon }[] = [
  { to: "/now", label: "Now", description: "Running and queued runs", icon: Timer },
  {
    to: "/automations",
    label: "Automations",
    description: "Schedules, webhooks and history",
    icon: Workflow,
  },
  {
    to: "/settings",
    label: "Settings",
    description: "Hosts, devices, projects, notifications",
    icon: Settings,
  },
];

/** Mobile "More": Now, Automations and Settings (spec 10). */
export default function MoreView() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-4 safe-pt">
      <h1 className="text-lg font-semibold">More</h1>
      <ul className="overflow-hidden rounded-lg border border-border bg-surface">
        {ITEMS.map(({ to, label, description, icon: Icon }) => (
          <li key={to} className="border-b border-border last:border-b-0">
            <Link
              to={to}
              className="tap flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-surface-2"
            >
              <Icon aria-hidden className="size-5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{label}</span>
                <span className="block truncate text-sm text-muted">{description}</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
