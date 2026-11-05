/**
 * Splits text into lines on LF only (never on U+2028/U+2029, valid inside JSON strings), strips
 * one trailing CR and skips empty lines. Imports nothing: the terminal extension loads it from
 * next to itself, and the holder and JsonlReader share it.
 */
export class LineSplitter {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(text: string): void {
    const buf = this.buffer + text;
    let start = 0;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n", start)) {
      this.emit(buf.slice(start, nl));
      start = nl + 1;
    }
    this.buffer = buf.slice(start);
  }

  /** Return and clear the unterminated rest (CR stripped). */
  end(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest.endsWith("\r") ? rest.slice(0, -1) : rest;
  }

  private emit(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line) this.onLine(line);
  }
}
