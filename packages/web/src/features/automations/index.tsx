import { Workflow } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the AutomationsView implementation. */
export default function AutomationsView() {
  return (
    <EmptyState
      icon={<Workflow className="size-8" />}
      title="Automations"
      description="Scheduled, webhook and dependency automations."
    />
  );
}
