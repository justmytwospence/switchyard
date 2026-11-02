import { Timer } from "lucide-react";
import { EmptyState } from "../../components/ui/states";

/** Placeholder: replaced by the NowView implementation. */
export default function NowView() {
  return (
    <EmptyState
      icon={<Timer className="size-8" />}
      title="Now"
      description="Running and queued runs, with the reason each queued task waits."
    />
  );
}
