import { SquareKanban } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the BoardView implementation. */
export default function BoardView() {
  return (
    <EmptyState
      icon={<SquareKanban className="size-8" />}
      title="Board"
      description="Tasks by state: Backlog, Ready, In progress, Review and Done."
    />
  );
}
