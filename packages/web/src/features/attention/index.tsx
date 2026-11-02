import { Bell } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the AttentionView implementation. */
export default function AttentionView() {
  return (
    <EmptyState
      icon={<Bell className="size-8" />}
      title="Attention"
      description="Questions, failures and reviews that need you."
    />
  );
}
