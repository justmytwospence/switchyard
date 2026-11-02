import { utimesSync } from "node:fs";
import { TranscriptItem } from "@switchyard/protocol";
import { piBin, when } from "@switchyard/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listImportable,
  parseEntriesFallback,
  readNativeTranscript,
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

describe("native session parsing", () => {
  it("fallback parser skips malformed lines", () => {
    expect(parseEntriesFallback('{"a":1}\nbroken\r\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
