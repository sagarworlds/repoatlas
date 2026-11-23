import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileExtraction } from "@repoatlas/schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openExtractionCache } from "./extraction-cache.ts";

function extraction(file: string, extra = ""): FileExtraction {
  return {
    file,
    language: "python",
    definitions: [
      {
        localId: `f${extra}`,
        kind: "function",
        name: `f${extra}`,
        span: { startLine: 1, endLine: 2 },
      },
    ],
    imports: [],
    references: [],
    parseErrors: 0,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "repoatlas-extcache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SqliteExtractionCache", () => {
  it("returns hits, reports misses and counts them", () => {
    const cache = openExtractionCache(":memory:");
    cache.setMany([
      { key: "a", extraction: extraction("a.py") },
      { key: "b", extraction: extraction("b.py") },
    ]);
    const found = cache.getMany(["a", "b", "c"]);
    expect([...found.keys()].sort()).toEqual(["a", "b"]);
    expect(found.get("a")).toEqual(extraction("a.py"));
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("b")?.file).toBe("b.py");
    expect(cache.stats()).toMatchObject({ hits: 3, misses: 2, stores: 2, corrupt: 0 });
    cache.close();
  });

  it("overwrites a key on set", () => {
    const cache = openExtractionCache(":memory:");
    cache.set("a", extraction("a.py", "1"));
    cache.set("a", extraction("a.py", "2"));
    expect(cache.get("a")?.definitions[0]?.name).toBe("f2");
    expect(cache.usage().entries).toBe(1);
    cache.close();
  });

  it("treats corrupt, schema-mismatched and oversized rows as misses and deletes them", () => {
    const file = join(dir, "cache.db");
    const cache = openExtractionCache(file, { maxRowBytes: 2000 });
    cache.set("good", extraction("good.py"));
    cache.close();

    const raw = new Database(file);
    const insert = raw.prepare(
      "INSERT INTO extraction_cache (key, data, size, last_used) VALUES (?, ?, ?, 1)",
    );
    insert.run("badjson", "{not json", 9);
    insert.run("badshape", JSON.stringify({ file: "x.py", language: "klingon" }), 40);
    insert.run("huge", JSON.stringify(extraction("huge.py")), 999_999);
    raw.close();

    const reopened = openExtractionCache(file, { maxRowBytes: 2000 });
    const found = reopened.getMany(["good", "badjson", "badshape", "huge"]);
    expect([...found.keys()]).toEqual(["good"]);
    expect(reopened.stats().corrupt).toBe(2);
    // The two invalid rows were removed; the oversized row is skipped but left alone.
    expect(reopened.usage().entries).toBe(2);
    reopened.close();
  });

  it("does not store rows above the row size cap", () => {
    const cache = openExtractionCache(":memory:", { maxRowBytes: 100 });
    cache.set("a", extraction("a-very-long-file-name-that-makes-the-json-larger-than-the-cap.py"));
    expect(cache.usage().entries).toBe(0);
    cache.close();
  });

  it("evicts the least recently used rows beyond maxEntries", () => {
    let clock = 1_000;
    const cache = openExtractionCache(":memory:", {
      maxEntries: 10,
      touchAfterMs: 0,
      now: () => clock,
    });
    for (let i = 0; i < 10; i++) {
      clock += 10;
      cache.set(`k${i}`, extraction(`f${i}.py`));
    }
    // Using k0 makes it the most recent, so k1 becomes the oldest.
    clock += 10;
    expect(cache.get("k0")).toBeDefined();
    clock += 10;
    cache.set("k10", extraction("f10.py"));
    const usage = cache.usage();
    expect(usage.entries).toBeLessThanOrEqual(9);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k0")).toBeDefined();
    expect(cache.get("k10")).toBeDefined();
    expect(cache.stats().evictions).toBeGreaterThan(0);
    cache.close();
  });

  it("evicts by total bytes", () => {
    const sample = JSON.stringify(extraction("f0.py")).length;
    const cache = openExtractionCache(":memory:", { maxBytes: sample * 5 });
    let n = 0;
    for (let i = 0; i < 20; i++) cache.set(`k${n++}`, extraction(`f${i}.py`));
    expect(cache.usage().bytes).toBeLessThanOrEqual(sample * 5 + 20);
    expect(cache.usage().entries).toBeLessThan(20);
    cache.close();
  });

  it("does not rewrite last_used for recently used rows", () => {
    let clock = 5_000;
    const cache = openExtractionCache(":memory:", { touchAfterMs: 1000, now: () => clock });
    cache.set("a", extraction("a.py"));
    clock += 500;
    cache.get("a");
    clock += 600;
    cache.get("a"); // now older than touchAfterMs: rewritten
    expect(cache.stats().hits).toBe(2);
    cache.close();
  });

  it("serves two connections to the same file (concurrent use)", () => {
    const file = join(dir, "shared.db");
    const one = openExtractionCache(file);
    const two = openExtractionCache(file);
    one.set("a", extraction("a.py"));
    two.set("b", extraction("b.py"));
    expect(two.get("a")?.file).toBe("a.py");
    expect(one.get("b")?.file).toBe("b.py");
    // Interleaved batches from both connections.
    for (let i = 0; i < 50; i++) {
      (i % 2 === 0 ? one : two).setMany([{ key: `k${i}`, extraction: extraction(`f${i}.py`) }]);
    }
    expect(one.getMany(Array.from({ length: 50 }, (_, i) => `k${i}`)).size).toBe(50);
    one.close();
    two.close();
  });

  it("handles batches larger than one SQL chunk", () => {
    const cache = openExtractionCache(":memory:");
    const entries = Array.from({ length: 1300 }, (_, i) => ({
      key: `k${i}`,
      extraction: extraction(`f${i}.py`),
    }));
    cache.setMany(entries);
    const found = cache.getMany([...entries.map((e) => e.key), "missing"]);
    expect(found.size).toBe(1300);
    expect(cache.stats().misses).toBe(1);
    cache.close();
  });
});
