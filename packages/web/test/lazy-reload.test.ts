import { describe, expect, it } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  claimChunkReload,
} from "../src/app/lazyWithReload";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe("claimChunkReload", () => {
  it("allows one reload per window", () => {
    const s = fakeStorage();
    expect(claimChunkReload(s, 100_000)).toBe(true);
    expect(s.m.get(CHUNK_RELOAD_KEY)).toBe("100000");
    expect(claimChunkReload(s, 100_000 + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(claimChunkReload(s, 100_000 + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
  });

  it("never reloads without storage", () => {
    expect(claimChunkReload(null, 1)).toBe(false);
  });
});
