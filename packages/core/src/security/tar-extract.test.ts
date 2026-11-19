import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisError } from "../errors.ts";
import type { Limits } from "../types.ts";
import { extractTarball } from "./tar-extract.ts";
import type { TarEntrySpec } from "./test-support/tar-builder.ts";
import { buildTar, tarStream } from "./test-support/tar-builder.ts";

const LIMITS: Limits = {
  maxTarballBytes: 100_000,
  maxFiles: 50,
  maxFileBytes: 1_000,
  analysisTimeoutMs: 60_000,
};

let root: string; // sandbox; the extraction directory is root/dest
let dest: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "repoatlas-tar-"));
  dest = path.join(root, "dest");
  // A sentinel next to dest so "nothing written outside" is observable.
  await writeFile(path.join(root, "sentinel.txt"), "keep");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Recursively list all paths under `dir` (forward slashes, sorted). */
async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((e) => e.replaceAll("\\", "/")).sort();
}

const TOP = "owner-repo-abc123";
const file = (p: string, content = "x"): TarEntrySpec => ({ path: `${TOP}/${p}`, content });

interface Outcome {
  result?: Awaited<ReturnType<typeof extractTarball>>;
  error?: unknown;
  outside: string[];
  inside: string[];
}

/** Run the extractor and snapshot everything outside dest before/after. */
async function run(entries: TarEntrySpec[], limits: Limits = LIMITS): Promise<Outcome> {
  const before = (await listTree(root)).filter((p) => p !== "dest" && !p.startsWith("dest/"));
  const out: Outcome = { outside: [], inside: [] };
  try {
    out.result = await extractTarball(tarStream(buildTar(entries)), dest, limits);
  } catch (err) {
    out.error = err;
  }
  const after = (await listTree(root)).filter((p) => p !== "dest" && !p.startsWith("dest/"));
  expect(after).toEqual(before); // nothing appeared outside destDir
  out.inside = (await listTree(dest)).filter((p) => p !== "");
  return out;
}

const reasons = (o: Outcome): Record<string, number> =>
  Object.fromEntries((o.result?.skipped ?? []).map((s) => [s.reason, s.count]));

describe("extractTarball: happy path", () => {
  it("strips the top-level folder and writes files", async () => {
    const o = await run([
      { path: `${TOP}/`, type: "dir" },
      { path: `${TOP}/src/`, type: "dir" },
      file("README.md", "hello"),
      file("src/index.ts", "export {};"),
      file("src/deep/nested/a.ts", "a"),
    ]);
    expect(o.error).toBeUndefined();
    expect(o.result?.files).toBe(3);
    expect(o.result?.bytes).toBe(5 + 10 + 1);
    expect(o.result?.skipped).toEqual([]);
    expect(o.inside).toEqual([
      "README.md",
      "src",
      "src/deep",
      "src/deep/nested",
      "src/deep/nested/a.ts",
      "src/index.ts",
    ]);
    expect(await readFile(path.join(dest, "src", "index.ts"), "utf8")).toBe("export {};");
  });

  it("writes files without execute bits (POSIX)", async () => {
    await run([file("run.sh", "#!/bin/sh")]);
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(dest, "run.sh"))).mode & 0o777;
      expect(mode & 0o111).toBe(0);
    }
  });

  it("handles long names via pax headers", async () => {
    const longName = `${"d".repeat(60)}/${"e".repeat(60)}/file.ts`;
    const o = await run([{ path: `${TOP}/${longName}`, content: "ok", pax: true }]);
    expect(o.result?.files).toBe(1);
    expect(o.inside).toContain(longName);
  });

  it("creates the destination directory when missing", async () => {
    const o = await run([]);
    expect(o.result?.files).toBe(0);
  });
});

describe("extractTarball: hostile paths", () => {
  it("skips ../ traversal", async () => {
    const o = await run([
      { path: `${TOP}/../evil.txt`, content: "pwn" },
      { path: "../evil2.txt", content: "pwn" },
      { path: `${TOP}/a/../../evil3.txt`, content: "pwn" },
      file("ok.txt"),
    ]);
    expect(reasons(o)).toEqual({ "unsafe-path": 3 });
    expect(o.inside).toEqual(["ok.txt"]);
  });

  it("skips absolute paths", async () => {
    const target = `/${path.join(root, "abs-target.txt").replaceAll("\\", "/")}`;
    const o = await run([
      { path: target, content: "pwn" },
      { path: "/etc/evil", content: "pwn" },
    ]);
    expect(reasons(o)).toEqual({ "unsafe-path": 2 });
    expect(o.inside).toEqual([]);
  });

  it("skips Windows drive-letter paths", async () => {
    const o = await run([
      { path: "C:/Windows/evil.txt", content: "pwn" },
      { path: "C:evil.txt", content: "pwn" },
    ]);
    expect(reasons(o)).toEqual({ "unsafe-path": 2 });
    expect(o.inside).toEqual([]);
  });

  it("skips backslash paths", async () => {
    const o = await run([{ path: `${TOP}\\..\\evil.txt`, content: "pwn" }, file("a\\b.ts")]);
    // On Windows the tar parser itself rewrites "\" to "/" before we see the path, so
    // "a\b.ts" may arrive as a legitimate nested path; the traversal entry is rejected
    // either way and nothing escapes (verified inside run()).
    expect(reasons(o)["unsafe-path"]).toBeGreaterThanOrEqual(1);
    expect(o.inside).not.toContain("evil.txt");
    if (process.platform !== "win32") expect(o.inside).toEqual([]);
  });

  it("never writes outside dest for NUL bytes in a path", async () => {
    const o = await run([
      { path: `${TOP}/ok.txt\0../../evil.txt`, content: "pwn", pax: true },
      file("fine.txt"),
    ]);
    // Depending on how the parser treats the NUL, the entry is skipped or truncated; either
    // way nothing escapes (checked inside run()) and the clean file is extracted.
    expect(o.inside).toContain("fine.txt");
    expect(o.inside).not.toContain("evil.txt");
  });
});

describe("extractTarball: links and special entries", () => {
  it("skips a symlink pointing at /etc/passwd", async () => {
    const o = await run([
      { path: `${TOP}/passwd`, type: "symlink", linkTarget: "/etc/passwd" },
      file("ok.txt"),
    ]);
    expect(reasons(o)).toEqual({ symlink: 1 });
    expect(o.inside).toEqual(["ok.txt"]);
  });

  it("does not write through a symlink that precedes a file of the same name", async () => {
    const o = await run([
      { path: `${TOP}/link`, type: "symlink", linkTarget: "../sentinel.txt" },
      { path: `${TOP}/link/inner.txt`, content: "pwn" },
    ]);
    expect(reasons(o).symlink).toBe(1);
    expect(await readFile(path.join(root, "sentinel.txt"), "utf8")).toBe("keep");
  });

  it("skips hardlinks", async () => {
    const o = await run([
      { path: `${TOP}/hl`, type: "hardlink", linkTarget: "../sentinel.txt" },
      file("ok.txt"),
    ]);
    expect(reasons(o)).toEqual({ hardlink: 1 });
    expect(o.inside).toEqual(["ok.txt"]);
  });
});

describe("extractTarball: limits", () => {
  it("skips files larger than maxFileBytes", async () => {
    const o = await run([file("big.bin", "x".repeat(LIMITS.maxFileBytes + 1)), file("small.txt")]);
    expect(reasons(o)).toEqual({ "too-large-file": 1 });
    expect(o.inside).toEqual(["small.txt"]);
  });

  it("skips a file whose header lies about its size is still bounded by real bytes", async () => {
    // Header says 5 bytes but 3000 bytes follow: the parser treats the extra data as headers.
    // The key property is that nothing outside dest is written and no crash occurs.
    const o = await run([{ path: `${TOP}/lie.txt`, content: "x".repeat(3000), declaredSize: 5 }]);
    expect(o.outside).toEqual([]);
  });

  it("aborts with REPO_TOO_LARGE when there are too many files", async () => {
    const entries = Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => file(`f${i}.txt`));
    const o = await run(entries);
    expect(o.error).toBeInstanceOf(AnalysisError);
    expect((o.error as AnalysisError).code).toBe("REPO_TOO_LARGE");
  });

  it("accepts exactly maxFiles files", async () => {
    const entries = Array.from({ length: LIMITS.maxFiles }, (_, i) => file(`f${i}.txt`));
    const o = await run(entries);
    expect(o.error).toBeUndefined();
    expect(o.result?.files).toBe(LIMITS.maxFiles);
  });

  it("aborts on a zip-bomb-like ratio (extracted bytes > 3x maxTarballBytes)", async () => {
    const limits: Limits = { ...LIMITS, maxTarballBytes: 2_000, maxFileBytes: 1_000 };
    const entries = Array.from({ length: 20 }, (_, i) => file(`chunk${i}.txt`, "z".repeat(900)));
    const o = await run(entries, limits);
    expect(o.error).toBeInstanceOf(AnalysisError);
    expect((o.error as AnalysisError).code).toBe("REPO_TOO_LARGE");
  });

  it("aborts with CANCELLED when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = extractTarball(
      tarStream(buildTar([file("a.txt")])),
      dest,
      LIMITS,
      controller.signal,
    );
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("maps AbortSignal.timeout style reasons to TIMEOUT", async () => {
    const controller = new AbortController();
    const reason = new Error("t");
    reason.name = "TimeoutError";
    controller.abort(reason);
    const promise = extractTarball(
      tarStream(buildTar([file("a.txt")])),
      dest,
      LIMITS,
      controller.signal,
    );
    await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("extractTarball: Windows-unsafe names (rejected on every OS)", () => {
  it("skips reserved device names, with or without extension, in any segment", async () => {
    const o = await run([
      file("aux.js"),
      file("src/CON"),
      file("NUL.txt"),
      file("com1.ts"),
      file("LPT9.tar.gz"),
      file("lib/prn/inner.ts"),
      file("auxiliary.js"), // not reserved
    ]);
    expect(reasons(o)).toEqual({ "reserved-name": 6 });
    expect(o.inside).toEqual(["auxiliary.js"]);
  });

  it("skips forbidden characters and control chars", async () => {
    const o = await run([
      file("a:b.ts"),
      file('q"uote.ts'),
      file("lt<.ts"),
      file("gt>.ts"),
      file("pipe|.ts"),
      file("what?.ts"),
      file("star*.ts"),
      file("bell\u0007.ts"),
      file("fine.ts"),
    ]);
    expect(reasons(o)).toEqual({ "unsafe-path": 8 });
    expect(o.inside).toEqual(["fine.ts"]);
  });

  it("skips segments ending in a dot or a space", async () => {
    const o = await run([file("name."), file("dir./x.ts"), file("trail "), file("ok.ts")]);
    expect(reasons(o)).toEqual({ "unsafe-path": 3 });
    expect(o.inside).toEqual(["ok.ts"]);
  });

  it("skips over-long path segments", async () => {
    const o = await run([
      { path: `${TOP}/${"n".repeat(300)}`, content: "x", pax: true },
      file("ok.ts"),
    ]);
    expect(reasons(o)).toEqual({ "path-too-long": 1 });
  });
});

describe("extractTarball: case collisions", () => {
  it("keeps the first and skips later entries that differ only by case", async () => {
    const o = await run([
      file("README.md", "first"),
      file("readme.md", "second"),
      file("Src/a.ts", "first"),
      file("src/a.ts", "second"),
      file("src/b.ts", "other dir casing"),
    ]);
    expect(reasons(o)).toEqual({ "case-collision": 3 });
    expect(o.inside).toEqual(["README.md", "Src", "Src/a.ts"]);
    expect(await readFile(path.join(dest, "README.md"), "utf8")).toBe("first");
  });

  it("skips exact duplicate paths and keeps the first", async () => {
    const o = await run([file("dup.txt", "one"), file("dup.txt", "two")]);
    expect(reasons(o)).toEqual({ duplicate: 1 });
    expect(await readFile(path.join(dest, "dup.txt"), "utf8")).toBe("one");
  });
});

describe("extractTarball: no overwriting", () => {
  it("never overwrites an existing file (wx flag)", async () => {
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, "exists.txt"), "original");
    const o = await run([file("exists.txt", "replacement")]);
    expect(reasons(o)).toEqual({ "path-conflict": 1 });
    expect(await readFile(path.join(dest, "exists.txt"), "utf8")).toBe("original");
  });
});
