import type { UINode } from "@switchyard/protocol";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface CustomFrameProps {
  hostId: string;
  adapterId: string;
  /** Portable node sent to the renderer (its fallback content). */
  node: UINode | null;
  /** Adapter-defined state passed through to the renderer. */
  state?: unknown;
  /** The renderer asked to run an adapter action. */
  onAction?: (actionId: string, payload?: unknown) => void;
  title: string;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
}

type FrameMessage =
  | { type: "action"; actionId: string; payload?: unknown }
  | { type: "resize"; height: number };

function isFrameMessage(v: unknown): v is FrameMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    (m.type === "action" && typeof m.actionId === "string") ||
    (m.type === "resize" && typeof m.height === "number")
  );
}

/**
 * Adapter web renderer in a sandboxed iframe (`allow-scripts` only, no
 * same-origin: it cannot read cookies, storage or the parent DOM). The bridge
 * is postMessage: parent sends `{type: "render", node, state}`; the frame
 * sends `{type: "action", actionId, payload}` or `{type: "resize", height}`.
 */
export function CustomFrame({
  hostId,
  adapterId,
  node,
  state,
  onAction,
  title,
  className,
  minHeight = 80,
  maxHeight = 1200,
}: CustomFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const [loaded, setLoaded] = useState(false);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Sandboxed frames have an opaque origin; trust only our frame's window.
      if (e.source !== ref.current?.contentWindow) return;
      if (!isFrameMessage(e.data)) return;
      if (e.data.type === "resize") {
        setHeight(Math.min(maxHeight, Math.max(minHeight, Math.ceil(e.data.height))));
      } else {
        actionRef.current?.(e.data.actionId, e.data.payload);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [minHeight, maxHeight]);

  useEffect(() => {
    if (!loaded) return;
    // Target "*" is required for an opaque-origin frame; the payload holds no secrets.
    ref.current?.contentWindow?.postMessage({ type: "render", node, state }, "*");
  }, [loaded, node, state]);

  const src = `/adapter-frames/${encodeURIComponent(hostId)}/${encodeURIComponent(adapterId)}`;
  return (
    <iframe
      ref={ref}
      title={title}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      onLoad={() => setLoaded(true)}
      style={{ height }}
      className={cn("block w-full rounded-md border border-border bg-surface", className)}
    />
  );
}
