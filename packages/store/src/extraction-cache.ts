import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type FileExtraction, FileExtractionSchema } from "@repoatlas/schema";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations/index.ts";
import { type Db, placeholders, stmt } from "./rows.ts";

/** Cumulative counters of one cache instance. */
export interface ExtractionCacheCounters {
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
  corrupt: number;
}

export interface ExtractionCacheOptions {
  /** Evict least recently used rows beyond this many rows. Default 200000. */
  maxEntries?: number;
  /** Evict least recently used rows beyond this many bytes of JSON. Default 500 MB. */
  maxBytes?: number;
  /** Rows larger than this are never stored or read (poisoned/oversized input). Default 4 MiB. */
  maxRowBytes?: number;
  /** `last_used` is only rewritten when older than this many ms (limits write traffic). Default 1 hour. */
  touchAfterMs?: number;
  /** Clock in epoch milliseconds (tests inject a fake one). */
  now?: () => number;
}

export const DEFAULT_MAX_ENTRIES = 200_000;
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_ROW_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOUCH_AFTER_MS = 60 * 60 * 1000;
/** Keys per SQL statement (SQLite allows 32766 variables; stay far below). */
const CHUNK = 500;
/** After eviction the cache holds about 90 percent of its cap, so it is not trimmed every run. */
const EVICT_TO_FRACTION = 0.9;
const EVICT_BATCH = 1000;

interface DataRow {
  key: string;
  data: string;
}

/**
 * SQLite-backed per-file extraction cache. It structurally matches the `ExtractionCache`
 * interface of @repoatlas/core (this package does not depend on core).
 *
 * Reads are validated with FileExtractionSchema: a row that is not valid JSON, does not
 * match the schema or is oversized is a miss (and is deleted), never an error. Each public
 * call is one transaction, so a whole analysis costs one read and one write transaction.
 * better-sqlite3 is synchronous: a batch of a few thousand rows blocks the event loop for
 * milliseconds, not seconds.
 */
export class SqliteExtractionCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxRowBytes: number;
  private readonly touchAfterMs: number;
  private readonly now: () => number;
  private readonly counters: ExtractionCacheCounters = {
    hits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
    corrupt: 0,
  };

  constructor(
    private readonly db: Db,
    options: ExtractionCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRowBytes = options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES;
    this.touchAfterMs = options.touchAfterMs ?? DEFAULT_TOUCH_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  get(key: string): FileExtraction | undefined {
    return this.getMany([key]).get(key);
  }

  set(key: string, extraction: FileExtraction): void {
    this.setMany([{ key, extraction }]);
  }

  getMany(keys: readonly string[]): Map<string, FileExtraction> {
    const unique = [...new Set(keys)];
    const found = new Map<string, FileExtraction>();
    if (unique.length === 0) return found;
    const corruptKeys: string[] = [];

    const run = this.db.transaction(() => {
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        // Oversized rows are filtered in SQL, so their data is never loaded.
        const rows = stmt(
          this.db,
          `SELECT key, data FROM extraction_cache
           WHERE size <= ? AND key IN (${placeholders(chunk.length)})`,
        ).all(this.maxRowBytes, ...chunk) as DataRow[];
        for (const row of rows) {
          const parsed = parseExtraction(row.data);
          if (parsed === undefined) corruptKeys.push(row.key);
          else found.set(row.key, parsed);
        }
      }
      this.deleteKeys(corruptKeys);
      this.touch([...found.keys()]);
    });
    run.immediate();

    this.counters.hits += found.size;
    this.counters.misses += unique.length - found.size;
    this.counters.corrupt += corruptKeys.length;
    return found;
  }

  setMany(entries: readonly { key: string; extraction: FileExtraction }[]): void {
    if (entries.length === 0) return;
    const now = this.now();
    let stored = 0;
    let evicted = 0;
    const run = this.db.transaction(() => {
      const upsert = stmt(
        this.db,
        `INSERT INTO extraction_cache (key, data, size, last_used) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           data = excluded.data, size = excluded.size, last_used = excluded.last_used`,
      );
      for (const entry of entries) {
        const data = serialize(entry.extraction);
        if (data === undefined) continue;
        const size = Buffer.byteLength(data, "utf8");
        if (size > this.maxRowBytes) continue;
        upsert.run(entry.key, data, size, now);
        stored++;
      }
      evicted = this.evictIfNeeded();
    });
    run.immediate();
    this.counters.stores += stored;
    this.counters.evictions += evicted;
  }

  stats(): ExtractionCacheCounters {
    return { ...this.counters };
  }

  /** Current number of rows and bytes (for monitoring and tests). */
  usage(): { entries: number; bytes: number } {
    const row = stmt(
      this.db,
      "SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM extraction_cache",
    ).get() as { n: number; bytes: number };
    return { entries: row.n, bytes: row.bytes };
  }

  /** Closes the connection (only for caches made by `openExtractionCache`). */
  close(): void {
    this.db.close();
  }

  private deleteKeys(keys: readonly string[]): void {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      stmt(
        this.db,
        `DELETE FROM extraction_cache WHERE key IN (${placeholders(chunk.length)})`,
      ).run(...chunk);
    }
  }

  /** Marks rows as used now, but only those not touched recently. */
  private touch(keys: readonly string[]): void {
    const now = this.now();
    const threshold = now - this.touchAfterMs;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK);
      stmt(
        this.db,
        `UPDATE extraction_cache SET last_used = ?
         WHERE last_used < ? AND key IN (${placeholders(chunk.length)})`,
      ).run(now, threshold, ...chunk);
    }
  }

  /** Deletes least recently used rows while over a cap; returns how many were deleted. */
  private evictIfNeeded(): number {
    const usage = this.usage();
    if (usage.entries <= this.maxEntries && usage.bytes <= this.maxBytes) return 0;
    const targetEntries = Math.max(1, Math.floor(this.maxEntries * EVICT_TO_FRACTION));
    const targetBytes = Math.floor(this.maxBytes * EVICT_TO_FRACTION);
    let entries = usage.entries;
    let bytes = usage.bytes;
    let evicted = 0;
    while (entries > targetEntries || bytes > targetBytes) {
      const oldest = stmt(
        this.db,
        "SELECT key, size FROM extraction_cache ORDER BY last_used ASC, key ASC LIMIT ?",
      ).all(EVICT_BATCH) as { key: string; size: number }[];
      if (oldest.length === 0) break;
      const doomed: string[] = [];
      for (const row of oldest) {
        if (entries <= targetEntries && bytes <= targetBytes) break;
        doomed.push(row.key);
        entries--;
        bytes -= row.size;
      }
      this.deleteKeys(doomed);
      evicted += doomed.length;
    }
    return evicted;
  }
}

/** JSON text -> validated FileExtraction, or undefined for anything wrong with it. */
function parseExtraction(text: string): FileExtraction | undefined {
  try {
    const parsed = FileExtractionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function serialize(extraction: FileExtraction): string | undefined {
  try {
    return JSON.stringify(extraction);
  } catch {
    return undefined; // e.g. a circular structure in `meta`: simply not cached
  }
}

/**
 * Opens a SQLite file (or ":memory:") as an extraction cache, creating/migrating the
 * `extraction_cache` table. It uses its own connection, so it can point at the same file as
 * `openStore` (WAL mode lets both work at once; `busy_timeout` waits for the other writer).
 */
export function openExtractionCache(
  location: string,
  options: ExtractionCacheOptions = {},
): SqliteExtractionCache {
  const inMemory = location === ":memory:";
  if (!inMemory) mkdirSync(dirname(location), { recursive: true });
  const db = new Database(location);
  try {
    db.pragma("busy_timeout = 5000");
    if (!inMemory) {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
    }
    runMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new SqliteExtractionCache(db, options);
}
