import type { CommandView } from "@switchyard/protocol";
import { UINodeRenderer } from "../../components/intent/UINodeRenderer";
import { Button } from "../../components/ui/Button";
import { Drawer, Sheet } from "../../components/ui/Overlay";

export interface CommandViewDrawerProps {
  view: CommandView | null;
  open: boolean;
  busy: boolean;
  mobile: boolean;
  onClose: () => void;
  onRun: (command: string) => void;
}

/** A plugin command's web view, with its follow-up commands as buttons. */
export function CommandViewDrawer({
  view,
  open,
  busy,
  mobile,
  onClose,
  onRun,
}: CommandViewDrawerProps) {
  if (!view) return null;
  const footer =
    view.actions.length > 0 ? (
      <div className="flex flex-wrap gap-2">
        {view.actions.map((a) => (
          <Button
            key={a.command}
            size="sm"
            variant={
              a.tone === "primary" ? "primary" : a.tone === "danger" ? "danger" : "secondary"
            }
            disabled={busy}
            onClick={() => onRun(a.command)}
          >
            {a.label}
          </Button>
        ))}
      </div>
    ) : undefined;
  const body = <UINodeRenderer node={view.body} />;
  return mobile ? (
    <Sheet open={open} onClose={onClose} title={view.title} footer={footer}>
      {body}
    </Sheet>
  ) : (
    <Drawer open={open} onClose={onClose} title={view.title} footer={footer} width={720}>
      {body}
    </Drawer>
  );
}
