import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisError } from "../errors.ts";
import { DEFAULT_LIMITS } from "../types.ts";
import { LocalDirFetcher } from "./local-fetcher.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "repoatlas-local-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalDirFetcher", () => {
  it("returns a deterministic 40-hex sha derived from the dir and the dir itself as rootDir", async () => {
    const a = new LocalDirFetcher({ dir });
    const first = await a.resolve({ owner: "o", repo: "r" });
    const second = await new LocalDirFetcher({ dir }).resolve({ owner: "o", repo: "r" });
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first).toEqual(second);
    expect(first.ref).toBe("local");

    const fetched = await a.fetch(
      { owner: "o", repo: "r", ref: "dev" },
      "/ignored",
      DEFAULT_LIMITS,
    );
    expect(fetched).toEqual({
      owner: "o",
      repo: "r",
      ref: "dev",
      commitSha: first.commitSha,
      rootDir: path.resolve(dir),
      skippedFiles: [],
    });
  });

  it("uses configured sha/owner/repo/ref and different dirs give different shas", async () => {
    const sha = "a".repeat(40);
    const f = new LocalDirFetcher({ dir, commitSha: sha, owner: "me", repo: "proj", ref: "v1" });
    const fetched = await f.fetch({ owner: "x", repo: "y" }, "/ignored", DEFAULT_LIMITS);
    expect(fetched).toMatchObject({ owner: "me", repo: "proj", ref: "v1", commitSha: sha });
    const other = await new LocalDirFetcher({ dir: path.join(dir, "sub") }).resolve({
      owner: "o",
      repo: "r",
    });
    const base = await new LocalDirFetcher({ dir }).resolve({ owner: "o", repo: "r" });
    expect(other.commitSha).not.toBe(base.commitSha);
  });

  it("rejects relative directories and malformed shas", () => {
    expect(() => new LocalDirFetcher({ dir: "relative/dir" })).toThrow(AnalysisError);
    expect(() => new LocalDirFetcher({ dir, commitSha: "xyz" })).toThrow(AnalysisError);
  });
});
