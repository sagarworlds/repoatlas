import { describe, expect, it } from "vitest";
import { MemoryExtractionCache, NoopExtractionCache } from "./extraction-cache.ts";
import {
  type ExtractionKeyParts,
  extractionCacheKey,
  extractionKeyForFile,
  hashContent,
} from "./extraction-cache-key.ts";

const base: ExtractionKeyParts = {
  analyzerVersion: "1",
  schemaVersion: 1,
  pluginId: "python",
  pluginVersion: "1",
  language: "python",
  path: "src/app.py",
  contentHash: hashContent("print(1)\n"),
};

describe("extractionCacheKey", () => {
  it("is stable for equal input and is a sha256 hex string", () => {
    expect(extractionCacheKey(base)).toBe(extractionCacheKey({ ...base }));
    expect(extractionCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any part changes", () => {
    const original = extractionCacheKey(base);
    const variants: Partial<ExtractionKeyParts>[] = [
      { analyzerVersion: "2" },
      { schemaVersion: 2 },
      { pluginId: "go" },
      { pluginVersion: "2" },
      { language: "javascript" },
      { path: "src/other.py" },
      { contentHash: hashContent("print(2)\n") },
    ];
    for (const change of variants) {
      expect(extractionCacheKey({ ...base, ...change })).not.toBe(original);
    }
  });

  it("does not confuse values that only differ in where a part ends", () => {
    const a = extractionCacheKey({ ...base, pluginId: "a", pluginVersion: "b1" });
    const b = extractionCacheKey({ ...base, pluginId: "ab", pluginVersion: "1" });
    expect(a).not.toBe(b);
  });

  it("hits for the same path and content, whatever the repository", () => {
    const plugin = { id: "python", version: "1" };
    const one = extractionKeyForFile(plugin, "python", "a.py", "x = 1\n");
    const two = extractionKeyForFile(plugin, "python", "a.py", "x = 1\n");
    expect(one).toBe(two);
    expect(extractionKeyForFile(plugin, "python", "b.py", "x = 1\n")).not.toBe(one);
    expect(extractionKeyForFile({ ...plugin, version: "2" }, "python", "a.py", "x = 1\n")).not.toBe(
      one,
    );
    expect(extractionKeyForFile(plugin, "python", "a.py", "x = 2\n")).not.toBe(one);
  });
});

describe("in-memory and no-op caches", () => {
  const extraction = {
    file: "a.py",
    language: "python" as const,
    definitions: [],
    imports: [],
    references: [],
    parseErrors: 0,
  };

  it("memory cache returns clones and evicts the least recently used entry", () => {
    const cache = new MemoryExtractionCache(2);
    cache.set("a", extraction);
    cache.set("b", extraction);
    cache.get("a");
    cache.set("c", extraction);
    expect(cache.get("b")).toBeUndefined();
    const a = cache.get("a");
    expect(a).toEqual(extraction);
    expect(a).not.toBe(extraction);
    expect(cache.stats()).toMatchObject({ stores: 3, evictions: 1 });
  });

  it("no-op cache never hits", () => {
    const cache = new NoopExtractionCache();
    cache.set("a", extraction);
    expect(cache.getMany(["a", "b"]).size).toBe(0);
    expect(cache.stats().misses).toBe(2);
  });
});
