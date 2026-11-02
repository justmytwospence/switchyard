import type { UINode } from "@switchyard/protocol";
import { Button } from "../ui/Button";
import { useIntent } from "./context";
import { Markdown } from "./Markdown";

type ConfirmNode = Extract<UINode, { t: "confirm" }>;

/** Yes/no question; responds `{kind: "confirm", confirmed}`. */
export function ConfirmRenderer({ node }: { node: ConfirmNode }) {
  const { onRespond, busy, disabled } = useIntent();
  return (
    <div className="flex flex-col gap-3">
      <Markdown text={node.message} />
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={node.destructive ? "danger" : "primary"}
            busy={busy}
            onClick={() => onRespond?.({ kind: "confirm", confirmed: true })}
          >
            {node.confirmLabel || "Confirm"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => onRespond?.({ kind: "confirm", confirmed: false })}
          >
            {node.cancelLabel || "Cancel"}
          </Button>
        </div>
      )}
    </div>
  );
}
