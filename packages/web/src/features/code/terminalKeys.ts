/** Pure helpers for the web terminal view. */

export const KEY_BAR: { label: string; data: string }[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "^C", data: "\x03" },
  { label: "←", data: "\x1b[D" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "→", data: "\x1b[C" },
];

/** Apply sticky Ctrl and Alt to the next key. */
export function applyModifiers(data: string, mods: { ctrl: boolean; alt: boolean }): string {
  let out = data;
  if (mods.ctrl && data.length === 1) {
    if (data === "?") out = "\x7f";
    else if (/[a-zA-Z]/.test(data))
      out = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
    else if ("@[\\]^_".includes(data)) out = String.fromCharCode(data.charCodeAt(0) & 0x1f);
  }
  return mods.alt ? `\x1b${out}` : out;
}

/** Font size (6..13 px) that makes `cols` columns fit `width` px. */
export function fitFontSize(width: number, cols: number, cellWidthAt13: number): number {
  return Math.min(13, Math.max(6, Math.floor((13 * width) / (cols * cellWidthAt13))));
}

export function terminalSocketUrl(
  loc: { protocol: string; host: string },
  sessionId: string,
  cols: number,
  rows: number,
): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/ws/terminal/${encodeURIComponent(sessionId)}?cols=${cols}&rows=${rows}&passive=1`;
}

export function toBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
