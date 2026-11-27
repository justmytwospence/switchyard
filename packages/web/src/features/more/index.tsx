import { ChevronRight, Pencil } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { NavigationEditor } from "../../app/NavigationEditor";
import { useNavLayout } from "../../app/navigation";
import { useBreakpoint } from "../../app/useBreakpoint";
import { CountBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Overlay";
import { useAttentionCount } from "../../sync/store";
import { usePalette } from "../palette/registry";

/** Mobile "More": the destinations that are not in the bottom bar, and Edit to choose them. */
export default function MoreView() {
  const { more } = useNavLayout();
  const count = useAttentionCount();
  const [editing, setEditing] = useState(false);
  // Keyboard shortcuts only matter with a keyboard: not on a phone.
  const phone = useBreakpoint() === "mobile";
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 pb-4 safe-pt-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold">More</h1>
        <Button
          size="sm"
          variant="ghost"
          icon={<Pencil className="size-4" />}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
      </div>
      <ul
        aria-label="More navigation"
        tabIndex={-1}
        data-keyboard-scope
        data-keyboard-default
        className="overflow-hidden rounded-lg border border-border bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {more.map(({ id, to, label, description, icon: Icon, badge }) => (
          <li key={id} className="border-b border-border last:border-b-0">
            <Link
              to={to}
              data-keyboard-item
              className="tap flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-surface-2 active:bg-surface-2"
            >
              <Icon aria-hidden className="size-5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{label}</span>
                <span className="block truncate text-sm text-muted">{description}</span>
              </span>
              {badge === "attention" && <CountBadge count={count} label="need attention" />}
              <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" />
            </Link>
          </li>
        ))}
      </ul>
      {!phone && (
        <Button variant="secondary" onClick={() => usePalette.getState().setHelpOpen(true)}>
          Keyboard shortcuts
        </Button>
      )}
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit navigation"
        description="Choose the bottom bar and the order of every page."
        footer={
          <Button variant="primary" onClick={() => setEditing(false)}>
            Done
          </Button>
        }
      >
        <NavigationEditor />
      </Sheet>
    </div>
  );
}
