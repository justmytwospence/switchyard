import { type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextArea } from "../../components/ui/TextArea";

interface Sel {
  text: string;
  top: number;
  left: number;
}

/** The finished reply element that contains the whole selection, if any. */
function replyOf(node: Node | null, root: HTMLElement): Element | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const reply = el?.closest('[data-assistant-reply="done"]') ?? null;
  return reply && root.contains(reply) ? reply : null;
}

/**
 * A small menu over a text selection inside one finished assistant reply: Quote puts it in
 * the draft, Comment keeps it with a note that goes first in the next message.
 */
export function ReplySelectionMenu({
  containerRef,
  onQuote,
  onComment,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
  onComment: (quote: string, comment: string) => void;
}) {
  const [sel, setSel] = useState<Sel | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const commentingRef = useRef(false);
  commentingRef.current = commenting;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (commentingRef.current) return;
      const root = containerRef.current;
      const s = window.getSelection();
      if (!root || !s || s.isCollapsed || s.rangeCount === 0 || !s.toString().trim()) {
        setSel(null);
        return;
      }
      const a = replyOf(s.anchorNode, root);
      const f = replyOf(s.focusNode, root);
      if (!a || a !== f) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const box = (wrapRef.current?.offsetParent ?? root).getBoundingClientRect();
      const above = rect.top - box.top;
      setSel({
        text: s.toString(),
        top: above >= 40 ? above - 40 : rect.bottom - box.top + 6,
        left: Math.max(4, rect.left - box.left),
      });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 150);
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerup", schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerup", schedule);
    };
  }, [containerRef]);

  const close = () => {
    setCommenting(false);
    setComment("");
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  if (!sel) return <div ref={wrapRef} hidden />;
  return (
    <div
      ref={wrapRef}
      data-testid="reply-selection-menu"
      style={{ top: sel.top, left: sel.left }}
      className="absolute z-20 flex max-w-[calc(100%-8px)] flex-col gap-2 rounded-lg border border-border bg-surface p-1.5 shadow-pop"
    >
      {commenting ? (
        <form
          className="flex w-72 max-w-full flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!comment.trim()) return;
            onComment(sel.text, comment);
            close();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <TextArea
            // biome-ignore lint/a11y/noAutofocus: the user just chose Comment
            autoFocus
            minRows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Comment on this part"
            aria-label="Comment on this part"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" type="button" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!comment.trim()}>
              Add comment
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              onQuote(sel.text);
              close();
            }}
          >
            Quote
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setCommenting(true)}
          >
            Comment
          </Button>
        </div>
      )}
    </div>
  );
}
