import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Strict JSONL reader: splits records on LF only and strips one trailing CR.
 * Unlike Node's `readline`, it never splits on U+2028/U+2029, which are valid inside JSON strings.
 */
export class JsonlReader {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(
    private readonly onRecord: (record: unknown) => void,
    private readonly onError: (error: Error, line: string) => void = () => {},
  ) {}

  /** Feed a chunk of bytes or text. */
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.emitLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  /** Flush a final unterminated record, if any. */
  end(): void {
    this.buffer += this.decoder.end();
    const rest = this.buffer;
    this.buffer = "";
    if (rest.length > 0) this.emitLine(rest);
  }

  private emitLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)), line);
      return;
    }
    this.onRecord(record);
  }

  /** Read a stream continuously (never paused) and deliver each record. */
  static attach(
    stream: Readable,
    onRecord: (record: unknown) => void,
    onError?: (error: Error, line: string) => void,
  ): JsonlReader {
    const reader = new JsonlReader(onRecord, onError);
    stream.on("data", (chunk: Buffer | string) => reader.push(chunk));
    stream.on("end", () => reader.end());
    return reader;
  }
}

/** Serialize one record as a JSON line. */
export function serializeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Write one JSON record followed by LF, honouring backpressure. */
export function writeJsonl(stream: Writable, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error("stream is closed"));
      return;
    }
    let ok: boolean;
    try {
      ok = stream.write(serializeJsonl(value), (err) => {
        if (err) reject(err);
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (ok) {
      resolve();
      return;
    }
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("close", onClose);
      stream.off("error", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("stream closed before drain"));
    };
    stream.on("drain", onDrain);
    stream.on("close", onClose);
    stream.on("error", onClose);
  });
}
