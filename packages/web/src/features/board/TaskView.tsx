import { SquareKanban } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the TaskView implementation. */
export default function TaskView() {
  return (
    <EmptyState
      icon={<SquareKanban className="size-8" />}
      title="Task"
      description="Task details, runs and review."
    />
  );
}
