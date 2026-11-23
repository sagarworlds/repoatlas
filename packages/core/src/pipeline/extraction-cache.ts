import type { FileExtraction } from "@repoatlas/schema";

/** Cumulative counters of one cache instance (they survive across analyses). */
export interface ExtractionCacheStats {
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
  /** Rows that failed validation (or were too large) and were treated as misses. */
  corrupt: number;
}

export interface ExtractionCacheEntry {
  key: string;
  extraction: FileExtraction;
}

/**
 * Per-file extraction cache (docs/ARCHITECTURE: extraction cache). Only Tier 1 plugins use
 * it: their `extract()` is pure per file. A cache is an optional optimization:
 *  - `getMany` returns only entries that passed validation; anything else is simply absent.
 *  - the calls are synchronous and batched (one call per plugin run, not one per file).
 *  - the pipeline catches errors from a cache and carries on without it.
 * (C# analogy: an `IDictionary<string, FileExtraction>` with a size limit.)
 * Keys are made by `extractionCacheKey` in extraction-cache-key.ts.
 */
export interface ExtractionCache {
  get(key: string): FileExtraction | undefined;
  set(key: string, extraction: FileExtraction): void;
  getMany(keys: readonly string[]): Map<string, FileExtraction>;
  setMany(entries: readonly ExtractionCacheEntry[]): void;
  stats(): ExtractionCacheStats;
}

/** Cache that never stores anything (used for `--no-cache` and as a test double). */
export class NoopExtractionCache implements ExtractionCache {
  private misses = 0;

  get(_key: string): undefined {
    this.misses++;
    return undefined;
  }
  set(_key: string, _extraction: FileExtraction): void {}
  getMany(keys: readonly string[]): Map<string, FileExtraction> {
    this.misses += keys.length;
    return new Map();
  }
  setMany(_entries: readonly ExtractionCacheEntry[]): void {}
  stats(): ExtractionCacheStats {
    return { hits: 0, misses: this.misses, stores: 0, evictions: 0, corrupt: 0 };
  }
}

/**
 * In-memory cache for tests and short-lived processes. Least recently used entries are
 * dropped beyond `maxEntries`. Values are cloned on the way in and out so callers can never
 * mutate what is stored.
 */
export class MemoryExtractionCache implements ExtractionCache {
  private readonly entries = new Map<string, FileExtraction>();
  private readonly counters: ExtractionCacheStats = {
    hits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
    corrupt: 0,
  };

  constructor(private readonly maxEntries = 100_000) {}

  get(key: string): FileExtraction | undefined {
    const found = this.entries.get(key);
    if (found === undefined) {
      this.counters.misses++;
      return undefined;
    }
    this.counters.hits++;
    // A Map iterates in insertion order, so delete + set marks the entry as most recent.
    this.entries.delete(key);
    this.entries.set(key, found);
    return structuredClone(found);
  }

  set(key: string, extraction: FileExtraction): void {
    this.entries.delete(key);
    this.entries.set(key, structuredClone(extraction));
    this.counters.stores++;
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.counters.evictions++;
    }
  }

  getMany(keys: readonly string[]): Map<string, FileExtraction> {
    const found = new Map<string, FileExtraction>();
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) found.set(key, value);
    }
    return found;
  }

  setMany(entries: readonly ExtractionCacheEntry[]): void {
    for (const entry of entries) this.set(entry.key, entry.extraction);
  }

  stats(): ExtractionCacheStats {
    return { ...this.counters };
  }

  get size(): number {
    return this.entries.size;
  }
}
