import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwitchyardError } from "@switchyard/protocol";
import { makeRepo, type TempRepo } from "@switchyard/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDir, MAX_READ_BYTES, readWorkspaceFile, resolveInside } from "../src/files.js";

async function expectCode(p: Promise<unknown>, code: string): Promise<SwitchyardError> {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}, but it succeeded`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SwitchyardError);
  expect((err as SwitchyardError).code).toBe(code);
  return err as SwitchyardError;
}

let repo: TempRepo;
let outside: string;

beforeEach(() => {
  repo = makeRepo();
  outside = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-outside-")));
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  mkdirSync(join(repo.path, "src", "nested"), { recursive: true });
  writeFileSync(join(repo.path, "src", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(repo.path, "src", "a.ts"), "export const a = 1;\n");
  mkdirSync(join(repo.path, "src", ".git"));
  writeFileSync(join(repo.path, "Zed.txt"), "zed\n");
  symlinkSync("README.md", join(repo.path, "link-in"));
  symlinkSync(join(outside, "secret.txt"), join(repo.path, "link-out"));
  symlinkSync(outside, join(repo.path, "dir-out"));
});

afterEach(() => {
  repo.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInside", () => {
  it("resolves paths inside the root", async () => {
    expect(await resolveInside(repo.path, "")).toBe(repo.path);
    expect(await resolveInside(repo.path, "/")).toBe(repo.path);
    expect(await resolveInside(repo.path, "src/a.ts")).toBe(join(repo.path, "src", "a.ts"));
    expect(await resolveInside(repo.path, "/src/a.ts")).toBe(join(repo.path, "src", "a.ts"));
    expect(await resolveInside(repo.path, "link-in")).toBe(join(repo.path, "README.md"));
  });

  it("refuses escapes", async () => {
    const err = await expectCode(resolveInside(repo.path, "../"), "forbidden");
    expect(err.message).toBe("Path is outside the workspace");
    await expectCode(resolveInside(repo.path, "src/../../x"), "forbidden");
    await expectCode(resolveInside(repo.path, "link-out"), "forbidden");
    await expectCode(resolveInside(repo.path, "dir-out/secret.txt"), "forbidden");
  });

  it("reports missing paths", async () => {
    await expectCode(resolveInside(repo.path, "missing.txt"), "not_found");
  });
});

describe("listDir", () => {
  it("lists the root with dirs first and hides .git", async () => {
    const { dir, entries } = await listDir(repo.path, "");
    expect(dir).toBe("");
    expect(entries.map((e) => e.name)).toEqual([
      "src",
      "README.md",
      "Zed.txt",
      "dir-out",
      "link-in",
      "link-out",
    ]);
    expect(entries.find((e) => e.name === "src")).toEqual({
      name: "src",
      path: "src",
      kind: "dir",
      size: null,
    });
    expect(entries.find((e) => e.name === "README.md")).toEqual({
      name: "README.md",
      path: "README.md",
      kind: "file",
      size: 12,
    });
    expect(entries.find((e) => e.name === "link-out")).toMatchObject({
      kind: "symlink",
      size: null,
    });
  });

  it("lists a subdirectory with root-relative paths", async () => {
    const { dir, entries } = await listDir(repo.path, "/src/");
    expect(dir).toBe("src");
    expect(entries.map((e) => e.path)).toEqual(["src/nested", "src/a.ts", "src/b.ts"]);
  });

  it("refuses escapes and files", async () => {
    await expectCode(listDir(repo.path, ".."), "forbidden");
    await expectCode(listDir(repo.path, "dir-out"), "forbidden");
    await expectCode(listDir(repo.path, "README.md"), "invalid_request");
  });
});

describe("readWorkspaceFile", () => {
  it("reads text files", async () => {
    expect(await readWorkspaceFile(repo.path, "src/a.ts")).toEqual({
      path: "src/a.ts",
      size: 20,
      encoding: "utf8",
      content: "export const a = 1;\n",
      binary: false,
    });
  });

  it("reads binary files as base64", async () => {
    writeFileSync(join(repo.path, "bin"), Buffer.from([1, 0, 2]));
    expect(await readWorkspaceFile(repo.path, "bin")).toEqual({
      path: "bin",
      size: 3,
      encoding: "base64",
      content: Buffer.from([1, 0, 2]).toString("base64"),
      binary: true,
    });
  });

  it("refuses directories, escapes and large files", async () => {
    await expectCode(readWorkspaceFile(repo.path, "src"), "invalid_request");
    await expectCode(readWorkspaceFile(repo.path, "../x"), "forbidden");
    await expectCode(readWorkspaceFile(repo.path, "link-out"), "forbidden");
    await expectCode(readWorkspaceFile(repo.path, "nope"), "not_found");
    writeFileSync(join(repo.path, "big.txt"), Buffer.alloc(MAX_READ_BYTES + 1, "a"));
    const err = await expectCode(readWorkspaceFile(repo.path, "big.txt"), "too_large");
    expect(err.message).toBe("File is larger than 1 MB");
    expect(err.details).toEqual({ size: MAX_READ_BYTES + 1 });
  });
});
