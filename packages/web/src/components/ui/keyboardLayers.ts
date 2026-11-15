import type { RefObject } from "react";

export interface KeyboardLayer {
  root: RefObject<HTMLElement | null>;
  onEscape: () => void;
  trapsFocus: boolean;
}

const layers: { layer: KeyboardLayer }[] = [];

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
  const top = topKeyboardLayer();
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.onEscape();
}

/** Register one open surface. The returned cleanup removes exactly this registration. */
export function registerKeyboardLayer(layer: KeyboardLayer): () => void {
  const entry = { layer };
  layers.push(entry);
  if (layers.length === 1) document.addEventListener("keydown", onDocumentKeyDown);
  return () => {
    const index = layers.indexOf(entry);
    if (index === -1) return;
    layers.splice(index, 1);
    if (layers.length === 0) document.removeEventListener("keydown", onDocumentKeyDown);
  };
}

export function topKeyboardLayer(): KeyboardLayer | undefined {
  return layers[layers.length - 1]?.layer;
}

export function topTrappingKeyboardLayer(): KeyboardLayer | undefined {
  return layers.findLast(({ layer }) => layer.trapsFocus)?.layer;
}

export function hasKeyboardLayer(): boolean {
  return layers.length > 0;
}
