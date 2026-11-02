import { Code } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the CodeView implementation. */
export default function CodeView() {
  return (
    <EmptyState
      icon={<Code className="size-8" />}
      title="Code"
      description="Sessions, transcripts and changes will appear here."
    />
  );
}
