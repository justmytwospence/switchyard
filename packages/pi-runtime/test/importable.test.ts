import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptItem } from "@switchyard/protocol";
import { piBin, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  entriesToMessages,
  listImportable,
  messagesToItems,
  parseEntriesFallback,
  readNativeTranscript,
  readSessionNameSync,
  resolvePiPackageRoot,
} from "../src/index.js";
import { type PiHarness, setupPi, skipRealPi, waitFor } from "./helpers.js";

describe.skipIf(skipRealPi)("importable sessions and native transcripts", () => {
  let h: PiHarness;
  beforeAll(async () => {
    h = await setupPi([
      {
        when: when.userSays("pick"),
        reply: { toolCalls: [{ name: "fixture_select", arguments: {} }] },
      },
      { when: when.toolResult(), reply: (r) => ({ text: `tool said: ${r.lastText}` }) },
    ]);
  });
  afterAll(async () => {
    await h?.dispose();
  });

  it("lists sessions with header data and reads them back as transcript items", async () => {
    const s = h.newSession({ title: "Import me" });
    await s.start();
    const ask = waitFor(s, "ui_request", (r: any) => r.method === "select");
    const settled = waitFor(s, "settled");
    await s.prompt("pick a fruit");
    const req: any = await ask;
    await s.respondUi(req.id, { value: "Apple" });
    await settled;
    const handle = s.nativeHandle!;
    await s.stop();

    let list = await listImportable(h.env.sessionsDir);
    const found = list.find((x) => x.sessionFile === handle.sessionFile);
    expect(found).toMatchObject({
      sessionId: handle.sessionId,
      cwd: h.env.cwd,
      name: "Import me",
      inactive: false,
    });
    // a file untouched for over 120 s is inactive
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(handle.sessionFile, old, old);
    list = await listImportable(h.env.sessionsDir);
    expect(list.find((x) => x.sessionFile === handle.sessionFile)?.inactive).toBe(true);

    expect(resolvePiPackageRoot(piBin())).toMatch(/pi-coding-agent$/);
    for (const usePiParser of [true, false]) {
      const native = await readNativeTranscript(handle.sessionFile, {
        sessionId: "ses_import",
        usePiParser,
      });
      expect(native.sessionId).toBe(handle.sessionId);
      expect(native.name).toBe("Import me");
      for (const item of native.items) expect(() => TranscriptItem.parse(item)).not.toThrow();
      const summary = native.items.map((i) =>
        i.kind === "tool"
          ? `tool:${i.data.name}:${i.data.status}:${i.data.output}`
          : `${i.kind}:${(i.data as any).text}`,
      );
      expect(summary).toEqual([
        "user:pick a fruit",
        "tool:fixture_select:ok:selected Apple",
        "assistant:tool said: selected Apple",
      ]);
      expect(native.items.every((i) => i.sessionId === "ses_import")).toBe(true);
    }
  });
});

describe("entry ids", () => {
  it("entriesToMessages keeps entry ids and messagesToItems puts them on user items", () => {
    const msgs = entriesToMessages([
      {
        id: "e9",
        type: "message",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "hi" },
      },
    ]);
    const items = messagesToItems(msgs, { sessionId: "s1" });
    expect(items[0]).toMatchObject({ kind: "user", data: { text: "hi", entryId: "e9" } });
  });
});

describe("native session parsing", () => {
  it("fallback parser skips malformed lines", () => {
    expect(parseEntriesFallback('{"a":1}\nbroken\r\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("session names", () => {
  const header = (id: string) =>
    `${JSON.stringify({ type: "session", id, cwd: "/x", timestamp: "2026-01-01T00:00:00.000Z" })}\n`;
  const info = (name: string) => `${JSON.stringify({ type: "session_info", name })}\n`;
  const filler = () => {
    let out = "";
    for (let i = 0; out.length < 100 * 1024; i++) {
      out += `${JSON.stringify({ type: "message", id: `m${i}`, message: { role: "user", content: "x".repeat(200) } })}\n`;
    }
    return out;
  };

  it("reads the latest name from the tail, falls back to the whole file, and caches", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-names-"));
    try {
      const file = join(root, "n1.jsonl");
      writeFileSync(file, header("n1") + info("A") + filler());
      expect(readSessionNameSync(file)).toBe("A");
      appendFileSync(file, info("B"));
      expect(readSessionNameSync(file)).toBe("B");
      appendFileSync(file, info(""));
      expect(readSessionNameSync(file)).toBeNull();

      const tailNamed = join(root, "n2.jsonl");
      writeFileSync(tailNamed, header("n2") + filler() + info("Tail"));
      const list = await listImportable(root);
      expect(list.find((x) => x.sessionId === "n1")?.name).toBeNull();
      expect(list.find((x) => x.sessionId === "n2")?.name).toBe("Tail");

      // The cache key is mtime and size: an in-place edit that keeps both is not seen.
      const fixed = new Date("2026-01-02T00:00:00.000Z");
      utimesSync(file, fixed, fixed);
      expect(readSessionNameSync(file)).toBeNull();
      const content = readFileSync(file, "utf8");
      const edited = `${content.slice(0, -info("").length)}${info("Z").slice(0, -1)}`;
      expect(edited.length).toBe(content.length);
      writeFileSync(file, edited);
      utimesSync(file, fixed, fixed);
      expect(readSessionNameSync(file)).toBeNull();
      const later = new Date("2026-01-03T00:00:00.000Z");
      utimesSync(file, later, later);
      expect(readSessionNameSync(file)).toBe("Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
