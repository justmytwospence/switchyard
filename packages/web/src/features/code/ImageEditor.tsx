import { ArrowUpRight, Circle, Crop, Pencil, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { toast } from "../../components/ui/Toast";
import {
  arrowHead,
  exportGeometry,
  initialHistory,
  MARKUP_COLOR,
  type Markup,
  markupReducer,
  type Pt,
  type Shape,
  strokeWidth,
} from "./imageMarkup";
import { type ImageAttachment, MAX_ATTACHMENT_BYTES, parseDataUrl } from "./model";

type Tool = "crop" | "pen" | "ellipse" | "arrow";

/** Paint the image area `src` (in image pixels) and the shapes onto `ctx` of size dw x dh. */
function paintShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  map: (p: Pt) => Pt,
  width: number,
  head: number,
) {
  ctx.strokeStyle = MARKUP_COLOR;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    ctx.beginPath();
    if (s.kind === "pen") {
      s.points.forEach((p, i) => {
        const [x, y] = map(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    } else if (s.kind === "ellipse") {
      const [x0, y0] = map(s.a);
      const [x1, y1] = map(s.b);
      ctx.ellipse(
        (x0 + x1) / 2,
        (y0 + y1) / 2,
        Math.max(1, Math.abs(x1 - x0) / 2),
        Math.max(1, Math.abs(y1 - y0) / 2),
        0,
        0,
        Math.PI * 2,
      );
    } else {
      const a = map(s.a);
      const b = map(s.b);
      const [h1, h2] = arrowHead(a, b, head);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.moveTo(h1[0], h1[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(h2[0], h2[1]);
    }
    ctx.stroke();
  }
}

function dataUrlToBlob(att: ImageAttachment): Blob {
  const bin = atob(att.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: att.mimeType });
}

function toBlob(canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
  return new Promise((r) => canvas.toBlob(r, type, q));
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function ImageEditor({
  attachment,
  open,
  onClose,
  onDone,
  mobile,
}: {
  attachment: ImageAttachment;
  open: boolean;
  onClose: () => void;
  onDone: (next: ImageAttachment) => void;
  mobile: boolean;
}) {
  const Surface = mobile ? Sheet : Dialog;
  const [tool, setTool] = useState<Tool>("pen");
  const [hist, dispatch] = useReducer(markupReducer, undefined, initialHistory);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [saving, setSaving] = useState(false);
  const [cropDraft, setCropDraft] = useState<Markup["crop"]>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const start = useRef<Pt | null>(null);
  const markup: Markup = hist.present;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    createImageBitmap(dataUrlToBlob(attachment)).then(
      (b) => alive && setBitmap(b),
      () => toast.error("Could not open this image"),
    );
    return () => {
      alive = false;
    };
  }, [open, attachment]);

  // Draw: the image fitted to the canvas, the shapes, and a dim overlay outside the crop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap) return;
    const maxW = Math.min(window.innerWidth - 48, 720);
    const maxH = Math.min(window.innerHeight * 0.6, 560);
    const scale = Math.min(maxW / bitmap.width, maxH / bitmap.height, 1);
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const map = (p: Pt): Pt => [p[0] * canvas.width, p[1] * canvas.height];
    const all = draft && draft.kind !== "pen" ? [...markup.shapes, draft] : markup.shapes;
    paintShapes(
      ctx,
      draft?.kind === "pen" ? [...all, draft] : all,
      map,
      Math.max(2, canvas.width * 0.004),
      canvas.width * 0.03,
    );
    const crop = cropDraft ?? markup.crop;
    if (crop) {
      const [x0, y0] = map(crop.a);
      const [x1, y1] = map(crop.b);
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fill("evenodd");
    }
  }, [bitmap, markup, draft, cropDraft]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };
  const shapeFor = (a: Pt, b: Pt, prev: Shape | null): Shape =>
    tool === "pen"
      ? { kind: "pen", points: [...(prev?.kind === "pen" ? prev.points : [a]), b] }
      : { kind: tool === "ellipse" ? "ellipse" : "arrow", a, b };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = point(e);
    if (tool === "pen") setDraft({ kind: "pen", points: [start.current] });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = start.current;
    if (!a) return;
    const b = point(e);
    if (tool === "crop") dispatchCropPreview(a, b);
    else setDraft((prev) => shapeFor(a, b, prev));
  };
  const dispatchCropPreview = (a: Pt, b: Pt) => setCropDraft({ a, b });
  const onUp = () => {
    if (!start.current) return;
    start.current = null;
    if (tool === "crop") {
      if (cropDraft) dispatch({ type: "crop", crop: cropDraft });
      setCropDraft(null);
    } else if (draft) {
      dispatch({ type: "add", shape: draft });
      setDraft(null);
    }
  };

  const done = async () => {
    if (!bitmap) return;
    setSaving(true);
    try {
      const g = exportGeometry(bitmap.width, bitmap.height, markup.crop);
      const out = document.createElement("canvas");
      out.width = g.dw;
      out.height = g.dh;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("Canvas is not available");
      ctx.drawImage(bitmap, g.sx, g.sy, g.sw, g.sh, 0, 0, g.dw, g.dh);
      const map = (p: Pt): Pt => [
        (p[0] * bitmap.width - g.sx) * (g.dw / g.sw),
        (p[1] * bitmap.height - g.sy) * (g.dh / g.sh),
      ];
      const w = strokeWidth(g.dw, g.dh);
      paintShapes(ctx, markup.shapes, map, w, w * 5);
      let blob = await toBlob(out, "image/png");
      if (blob && blob.size > MAX_ATTACHMENT_BYTES) blob = await toBlob(out, "image/jpeg", 0.9);
      if (!blob || blob.size > MAX_ATTACHMENT_BYTES) {
        toast.error("The edited image is over 10 MB; crop it smaller");
        return;
      }
      const parsed = parseDataUrl(await readDataUrl(blob));
      if (!parsed) throw new Error("Could not encode the image");
      onDone({ ...attachment, mimeType: parsed.mimeType, data: parsed.data, size: blob.size });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Surface
      open={open}
      onClose={onClose}
      title="Mark up image"
      dismissOnBackdrop={false}
      className={mobile ? undefined : "max-w-3xl"}
      fullHeight={mobile}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} disabled={!bitmap} onClick={() => void done()}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<Tool>
            label="Tool"
            value={tool}
            onChange={setTool}
            options={[
              { value: "crop", label: "Crop", icon: <Crop className="size-4" /> },
              { value: "pen", label: "Pen", icon: <Pencil className="size-4" /> },
              { value: "ellipse", label: "Circle", icon: <Circle className="size-4" /> },
              { value: "arrow", label: "Arrow", icon: <ArrowUpRight className="size-4" /> },
            ]}
          />
          <IconButton
            label="Undo"
            icon={<Undo2 className="size-4" />}
            disabled={hist.past.length === 0}
            onClick={() => dispatch({ type: "undo" })}
          />
          <IconButton
            label="Redo"
            icon={<Redo2 className="size-4" />}
            disabled={hist.future.length === 0}
            onClick={() => dispatch({ type: "redo" })}
          />
          <IconButton
            label="Reset"
            icon={<RotateCcw className="size-4" />}
            onClick={() => dispatch({ type: "reset" })}
          />
        </div>
        <canvas
          ref={canvasRef}
          data-testid="markup-canvas"
          aria-label="Image to mark up"
          className="max-w-full rounded border border-border"
          style={{ touchAction: "none" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </div>
    </Surface>
  );
}
