import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, relativeTime, shortSha } from "./format.ts";
import { buildGithubBlobUrl } from "./github.ts";
import {
  addRecent,
  MAX_RECENT,
  RECENT_STORAGE_KEY,
  type RecentEntry,
  readRecent,
  updateRecentStatus,
} from "./recent.ts";
import { parseRepoInput, validateRef } from "./repo-input.ts";

describe("parseRepoInput", () => {
  it("accepts owner/repo shorthand", () => {
    expect(parseRepoInput("pmndrs/zustand")).toEqual({
      ok: true,
      owner: "pmndrs",
      repo: "zustand",
      repoUrl: "https://github.com/pmndrs/zustand",
    });
  });

  it("accepts full urls, .git suffixes and tree urls", () => {
    for (const text of [
      "https://github.com/pmndrs/zustand",
      "https://github.com/pmndrs/zustand.git",
      "https://www.github.com/pmndrs/zustand/tree/main/src",
      "github.com/pmndrs/zustand",
    ]) {
      const r = parseRepoInput(text);
      expect(r).toMatchObject({ ok: true, owner: "pmndrs", repo: "zustand" });
    }
  });

  it("rejects other hosts, schemes and malformed input", () => {
    const bad = [
      "",
      "   ",
      "zustand",
      "a/b/c",
      "http://github.com/a/b",
      "git@github.com:a/b.git",
      "file:///etc/passwd",
      "https://github.com.evil.com/a/b",
      "https://user:pw@github.com/a/b",
      "https://gitlab.com/a/b",
      "a b/c",
      "-bad/repo",
      "owner/..",
    ];
    for (const text of bad) {
      expect(parseRepoInput(text).ok, text).toBe(false);
    }
  });
});

describe("validateRef", () => {
  it("allows empty and normal refs, rejects odd ones", () => {
    expect(validateRef("")).toBeUndefined();
    expect(validateRef("feature/x-1.2")).toBeUndefined();
    expect(validateRef("a..b")).toBeDefined();
    expect(validateRef("a b")).toBeDefined();
    expect(validateRef("/a")).toBeDefined();
  });
});

describe("recent store", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const entry = (id: string, status: RecentEntry["status"] = "queued"): RecentEntry => ({
    id,
    repo: "a/b",
    ref: "main",
    date: "2026-01-01T00:00:00.000Z",
    status,
  });

  it("starts empty and adds newest first", () => {
    expect(readRecent()).toEqual([]);
    addRecent(entry("an_1"));
    addRecent(entry("an_2"));
    expect(readRecent().map((e) => e.id)).toEqual(["an_2", "an_1"]);
  });

  it("dedupes by id and caps the list", () => {
    addRecent(entry("an_1"));
    addRecent(entry("an_1", "done"));
    expect(readRecent()).toHaveLength(1);
    expect(readRecent()[0]?.status).toBe("done");
    for (let i = 0; i < MAX_RECENT + 5; i++) addRecent(entry(`x_${i}`));
    expect(readRecent()).toHaveLength(MAX_RECENT);
  });

  it("updates the status of an entry", () => {
    addRecent(entry("an_1"));
    updateRecentStatus("an_1", "failed");
    updateRecentStatus("missing", "done");
    expect(readRecent()).toEqual([{ ...entry("an_1"), status: "failed" }]);
  });

  it("survives corrupted JSON and invalid rows", () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, "{not json");
    expect(readRecent()).toEqual([]);
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(readRecent()).toEqual([]);
    window.localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([entry("ok"), { id: 5 }, null, { ...entry("bad"), status: "weird" }]),
    );
    expect(readRecent().map((e) => e.id)).toEqual(["ok"]);
  });

  it("never throws when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRecent()).toEqual([]);
    expect(() => addRecent(entry("an_1"))).not.toThrow();
  });
});

describe("buildGithubBlobUrl", () => {
  it("builds a line range url and encodes each segment", () => {
    expect(buildGithubBlobUrl("o", "r", "abc", "src/my dir/a#b.ts", 3, 9)).toBe(
      "https://github.com/o/r/blob/abc/src/my%20dir/a%23b.ts#L3-L9",
    );
  });

  it("handles a single line and no lines", () => {
    expect(buildGithubBlobUrl("o", "r", "abc", "a.ts", 5, 5)).toBe(
      "https://github.com/o/r/blob/abc/a.ts#L5",
    );
    expect(buildGithubBlobUrl("o", "r", "abc", "a.ts")).toBe(
      "https://github.com/o/r/blob/abc/a.ts",
    );
  });
});

describe("format helpers", () => {
  it("shortens shas", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(null)).toBe("");
  });

  it("formats relative time", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(relativeTime("2026-01-10T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-01-10T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-01-10T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-01-08T12:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("garbage", now)).toBe("");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(3500)).toBe("3s");
    expect(formatElapsed(65000)).toBe("1m 05s");
  });
});
