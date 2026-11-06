import { useMemo } from "react";
import { useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { useSyncStore } from "../../sync/store";
import { SECTIONS } from "../settings/shared";
import type { PaletteItem } from "./registry";

/** Palette items for every session, task, project, host, settings section and global action. */
export function useGlobalItems(): PaletteItem[] {
  const navigate = useNavigate();
  const sessions = useSyncStore((s) => s.sessions);
  const tasks = useSyncStore((s) => s.tasks);
  const projects = useSyncStore((s) => s.projects);
  const hosts = useSyncStore((s) => s.hosts);
  return useMemo(() => {
    const go = (path: string, state?: unknown) => () => navigate(path, { state });
    const items: PaletteItem[] = [];
    for (const s of Object.values(sessions)) {
      if (s.archivedAt) continue;
      items.push({
        id: s.id,
        title: s.title,
        subtitle: s.projectId ? projects[s.projectId]?.name : undefined,
        group: "Sessions",
        activityAt: s.lastActivityAt,
        run: go(`/code/${encodeURIComponent(s.id)}`, BACK_STATE),
      });
    }
    for (const t of Object.values(tasks)) {
      items.push({
        id: `task:${t.id}`,
        title: t.title,
        group: "Tasks",
        activityAt: t.lastActivityAt,
        run: go(`/tasks/${encodeURIComponent(t.id)}`),
      });
    }
    for (const p of Object.values(projects)) {
      items.push({
        id: `project:${p.id}`,
        title: p.name,
        group: "Projects",
        run: go(`/settings/projects/${encodeURIComponent(p.id)}`),
      });
    }
    for (const h of Object.values(hosts)) {
      if (h.revokedAt) continue;
      items.push({
        id: `host:${h.id}`,
        title: h.name,
        group: "Hosts",
        run: go(`/settings/hosts/${encodeURIComponent(h.id)}`),
      });
    }
    for (const sec of SECTIONS) {
      items.push({
        id: `settings:${sec.path}`,
        title: sec.label,
        subtitle: sec.description,
        group: "Settings",
        run: go(`/settings/${sec.path}`),
      });
    }
    const action = (
      id: string,
      title: string,
      run: () => void,
      shortcut?: PaletteItem["shortcut"],
    ) => items.push({ id: `action:${id}`, title, group: "Actions", run, shortcut });
    action("new", "New session", go("/code", { newSession: true }), "newSession");
    action("code", "Go to Code", go("/code"), "goCode");
    action("board", "Go to Board", go("/board"), "goBoard");
    action("attention", "Go to Attention", go("/attention"), "goAttention");
    action("queue", "Go to Queue", go("/queue"));
    action("automations", "Go to Automations", go("/automations"));
    action("settings", "Go to Settings", go("/settings"), "goSettings");
    return items;
  }, [navigate, sessions, tasks, projects, hosts]);
}
