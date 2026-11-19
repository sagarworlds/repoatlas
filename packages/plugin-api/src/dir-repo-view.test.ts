import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirRepoView } from "./dir-repo-view.ts";

let base: string;
let root: string;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "repoatlas-dirview-"));
  root = path.join(base, "repo");
  mkdirSync(path.join(root, "src", "sub"), { recursive: true });
  writeFileSync(path.join(root, "src", "b.ts"), "export const b = 1;\n");
  writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "README.md"), "hi");
  writeFileSync(path.join(base, "secret.txt"), "secret");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("createDirRepoView", () => {
  it("reads, lists (sorted) and stats files", async () => {
    const view = createDirRepoView(root);
    expect(view.exists("src/a.ts")).toBe(true);
    expect(view.isDir("src")).toBe(true);
    expect(view.isDir("")).toBe(true);
    expect(view.isDir("src/a.ts")).toBe(false);
    expect(view.readSync("src/a.ts")).toBe("export const a = 1;\n");
    expect(await view.read("src/b.ts")).toBe("export const b = 1;\n");
    expect(view.list("src")).toEqual(["a.ts", "b.ts", "sub"]);
    expect(view.list("")).toEqual(["README.md", "src"]);
  });

  it("treats missing paths as absent", async () => {
    const view = createDirRepoView(root);
    expect(view.exists("nope.ts")).toBe(false);
    expect(view.readSync("nope.ts")).toBeUndefined();
    expect(await view.read("nope.ts")).toBeUndefined();
    expect(view.list("nope")).toEqual([]);
    expect(view.list("src/a.ts")).toEqual([]);
    expect(view.readSync("src")).toBeUndefined();
  });

  it("rejects traversal and unsafe paths", async () => {
    const view = createDirRepoView(root);
    const bad = [
      "../secret.txt",
      "src/../../secret.txt",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "src\\a.ts",
      "./src/a.ts",
      "src/./a.ts",
      "src/a.ts\0",
    ];
    for (const p of bad) {
      expect(view.exists(p), p).toBe(false);
      expect(view.isDir(p), p).toBe(false);
      expect(view.readSync(p), p).toBeUndefined();
      expect(await view.read(p), p).toBeUndefined();
      expect(view.list(p), p).toEqual([]);
    }
    expect(view.exists(path.join(base, "secret.txt").replaceAll("\\", "/"))).toBe(false);
  });

  it("never follows symlinks", () => {
    try {
      symlinkSync(path.join(base, "secret.txt"), path.join(root, "link.txt"), "file");
      symlinkSync(base, path.join(root, "linkdir"), "junction");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return; // cannot create symlinks here
      throw err;
    }
    const view = createDirRepoView(root);
    expect(view.exists("link.txt")).toBe(false);
    expect(view.readSync("link.txt")).toBeUndefined();
    expect(view.exists("linkdir")).toBe(false);
    expect(view.readSync("linkdir/secret.txt")).toBeUndefined();
    expect(view.list("linkdir")).toEqual([]);
    expect(view.list("")).not.toContain("link.txt");
    expect(view.list("")).not.toContain("linkdir");
  });
});
