import {
  Bell,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  Settings,
  SquareKanban,
  Timer,
  Workflow,
} from "lucide-react";
import { usePrefs } from "../prefs";

export type NavId = "code" | "board" | "attention" | "tasks" | "queue" | "automations" | "settings";

export interface Destination {
  id: NavId;
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Path prefixes that make this destination active. */
  match: string[];
  badge?: "attention";
}

export const DESTINATIONS: Record<NavId, Destination> = {
  code: {
    id: "code",
    to: "/code",
    label: "Sessions",
    description: "Pi sessions on every host",
    icon: MessagesSquare,
    match: ["/code"],
  },
  board: {
    id: "board",
    to: "/board",
    label: "Board",
    description: "Branches by stage",
    icon: SquareKanban,
    match: ["/board"],
  },
  attention: {
    id: "attention",
    to: "/attention",
    label: "Attention",
    description: "Questions, failures and reviews",
    icon: Bell,
    match: ["/attention"],
    badge: "attention",
  },
  tasks: {
    id: "tasks",
    to: "/tasks",
    label: "Tasks",
    description: "Automation tasks and review",
    icon: ListChecks,
    match: ["/tasks"],
  },
  queue: {
    id: "queue",
    to: "/queue",
    label: "Queue",
    description: "Running and queued runs",
    icon: Timer,
    match: ["/queue"],
  },
  automations: {
    id: "automations",
    to: "/automations",
    label: "Automations",
    description: "Schedules, webhooks and history",
    icon: Workflow,
    match: ["/automations"],
  },
  settings: {
    id: "settings",
    to: "/settings",
    label: "Settings",
    description: "Hosts, devices, projects, notifications",
    icon: Settings,
    match: ["/settings"],
  },
};

export const DEFAULT_NAV_ORDER: NavId[] = [
  "code",
  "board",
  "attention",
  "tasks",
  "queue",
  "automations",
  "settings",
];
/** Destinations in the phone's bottom bar by default; the rest are under More. */
export const DEFAULT_NAV_BAR = 3;
/** The bottom bar holds at most this many, beside More. */
export const MAX_NAV_BAR = 4;

/** A stored order made whole: unknown entries dropped, new destinations appended, bar clamped. */
export function normalizeNav(order: unknown, bar: unknown): { order: NavId[]; bar: number } {
  const known = new Set<string>(DEFAULT_NAV_ORDER);
  const seen = new Set<string>();
  const out: NavId[] = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id === "string" && known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id as NavId);
    }
  }
  for (const id of DEFAULT_NAV_ORDER) if (!seen.has(id)) out.push(id);
  const n = typeof bar === "number" && Number.isFinite(bar) ? Math.round(bar) : DEFAULT_NAV_BAR;
  return { order: out, bar: Math.min(MAX_NAV_BAR, Math.max(1, n)) };
}

export interface NavLayout {
  /** Every destination in the chosen order (the desktop rail). */
  all: Destination[];
  /** The phone's bottom bar, before More. */
  bar: Destination[];
  /** Under More on the phone. */
  more: Destination[];
}

export function navLayout(order: unknown, bar: unknown): NavLayout {
  const n = normalizeNav(order, bar);
  const all = n.order.map((id) => DESTINATIONS[id]);
  return { all, bar: all.slice(0, n.bar), more: all.slice(n.bar) };
}

export function useNavLayout(): NavLayout {
  const order = usePrefs((s) => s.navOrder);
  const bar = usePrefs((s) => s.navBar);
  return navLayout(order, bar);
}

export function isActive(d: { match: string[] }, pathname: string): boolean {
  return d.match.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
