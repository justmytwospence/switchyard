import { Workflow } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the AutomationView implementation. */
export default function AutomationView() {
  return (
    <EmptyState
      icon={<Workflow className="size-8" />}
      title="Automation"
      description="Trigger, task template, limits and history."
    />
  );
}
