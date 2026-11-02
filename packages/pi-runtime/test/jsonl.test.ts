import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonlReader, writeJsonl } from "../src/jsonl.js";

function collect(): { records: unknown[]; errors: string[]; reader: JsonlReader } {
  const records: unknown[] = [];
  const errors: string[] = [];
  const reader = new JsonlReader(
    (r) => records.push(r),
    (_e, line) => errors.push(line),
  );
  return { records, errors, reader };
}

describe("JsonlReader", () => {
  it("keeps U+2028 and U+2029 inside strings", () => {
    const { records, reader } = collect();
    const text = "a\u2028b\u2029c";
    reader.push(Buffer.from(`${JSON.stringify({ text })}\n`, "utf8"));
    expect(records).toEqual([{ text }]);
  });

  it("strips one trailing CR (CRLF input)", () => {
    const { records, reader } = collect();
    reader.push('{"a":1}\r\n{"b":2}\r\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reassembles records split across chunks, including split UTF-8 sequences", () => {
    const { records, reader } = collect();
    const line = Buffer.from(`${JSON.stringify({ emoji: "héllo 🎉", n: 1 })}\n`, "utf8");
    for (let i = 0; i < line.length; i += 3) reader.push(line.subarray(i, i + 3));
    expect(records).toEqual([{ emoji: "héllo 🎉", n: 1 }]);
  });

  it("delivers several records from one chunk and flushes an unterminated tail on end", () => {
    const { records, reader } = collect();
    reader.push('{"a":1}\n{"b":2}\n{"c"');
    reader.push(":3}");
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    reader.end();
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("reports malformed lines without stopping", () => {
    const { records, errors, reader } = collect();
    reader.push('not json\n{"ok":true}\n\n');
    expect(errors).toEqual(["not json"]);
    expect(records).toEqual([{ ok: true }]);
  });

  it("attaches to a stream", async () => {
    const stream = new PassThrough();
    const records: unknown[] = [];
    JsonlReader.attach(stream, (r) => records.push(r));
    stream.write('{"x":"\u2028"}\n');
    stream.end('{"y":2}');
    await new Promise((r) => stream.on("end", r));
    expect(records).toEqual([{ x: "\u2028" }, { y: 2 }]);
  });
});

describe("writeJsonl", () => {
  it("writes one LF-terminated line per record, keeping U+2028 raw", async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    await writeJsonl(sink, { a: "x\u2028y" });
    expect(chunks.join("")).toBe('{"a":"x\u2028y"}\n');
  });

  it("waits for drain under backpressure", async () => {
    let release: (() => void) | null = null;
    const sink = new Writable({
      highWaterMark: 4,
      write(_chunk, _enc, cb) {
        release = cb;
      },
    });
    let done = false;
    const p = writeJsonl(sink, { long: "0123456789" }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release!();
    await p;
    expect(done).toBe(true);
  });

  it("rejects on a closed stream", async () => {
    const sink = new PassThrough();
    sink.end();
    await expect(writeJsonl(sink, { a: 1 })).rejects.toThrow();
  });
});
