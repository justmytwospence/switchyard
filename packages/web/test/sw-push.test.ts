import { describe, expect, it } from "vitest";
import { FALLBACK_PUSH, parsePushData, resolvedNotice } from "../src/swPush";

const json = (v: unknown) => ({
  json: () => v,
  text: () => JSON.stringify(v),
});
const text = (t: string) => ({
  json: (): unknown => {
    throw new SyntaxError("not json");
  },
  text: () => t,
});

describe("parsePushData", () => {
  it("shows the fallback when there is no data", () => {
    expect(parsePushData(null)).toEqual(FALLBACK_PUSH);
  });

  it("shows invalid JSON as plain text", () => {
    expect(parsePushData(text("Build finished"))).toEqual({
      ...FALLBACK_PUSH,
      body: "Build finished",
    });
    expect(parsePushData(text(""))).toEqual(FALLBACK_PUSH);
  });

  it("falls back for an unknown type or a malformed show", () => {
    expect(parsePushData(json({ type: "mystery" }))).toEqual(FALLBACK_PUSH);
    expect(parsePushData(json(null))).toEqual(FALLBACK_PUSH);
    expect(parsePushData(json({ type: "show", title: "t", body: 1, tag: "x", url: "/" }))).toEqual(
      FALLBACK_PUSH,
    );
    expect(parsePushData(json({ type: "clear" }))).toEqual(FALLBACK_PUSH);
  });

  it("parses a valid show and a clear", () => {
    expect(
      parsePushData(
        json({
          type: "show",
          title: "Q",
          body: "b",
          tag: "ses_1",
          url: "/code/ses_1",
          renotify: true,
        }),
      ),
    ).toEqual({
      type: "show",
      title: "Q",
      body: "b",
      tag: "ses_1",
      url: "/code/ses_1",
      renotify: true,
    });
    expect(parsePushData(json({ type: "clear", tag: "ses_1" }))).toEqual({
      type: "clear",
      tag: "ses_1",
    });
  });
});

describe("resolvedNotice", () => {
  it("is silent, keeps the tag and the previous URL", () => {
    const n = resolvedNotice("ses_1", { title: "Pick a fruit", data: { url: "/code/ses_1" } });
    expect(n.title).toBe("Resolved");
    expect(n.options).toMatchObject({
      tag: "ses_1",
      silent: true,
      renotify: false,
      body: "Pick a fruit no longer needs you.",
      data: { url: "/code/ses_1", resolved: true },
    });
  });

  it("falls back to /attention without a previous notification", () => {
    const n = resolvedNotice("ses_1", null);
    expect(n.options.data).toEqual({ url: "/attention", resolved: true });
    expect(n.options.body).toBe("A Switchyard item no longer needs you.");
    expect(resolvedNotice("t", { title: "x", data: { url: 5 } }).options.data.url).toBe(
      "/attention",
    );
  });
});
