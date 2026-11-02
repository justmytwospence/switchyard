import { Settings } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the SettingsView implementation. */
export default function SettingsView() {
  return (
    <EmptyState
      icon={<Settings className="size-8" />}
      title="Settings"
      description="Hosts, devices, projects, profiles, adapters, notifications, backups and diagnostics."
    />
  );
}
