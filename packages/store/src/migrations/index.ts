import type Database from "better-sqlite3";
import { initialMigration } from "./001-initial.ts";
import { rollupVariantsMigration } from "./002-rollup-variants.ts";
import { extractionCacheMigration } from "./003-extraction-cache.ts";

/** Ordered list. Index + 1 is the `PRAGMA user_version` after the migration ran. Append only. */
export const MIGRATIONS: readonly string[] = [
  initialMigration,
  rollupVariantsMigration,
  extractionCacheMigration,
];

/**
 * Applies pending migrations, each in its own transaction, and records progress in
 * `PRAGMA user_version` (like a __MigrationHistory table, but a single integer).
 * Re-opening an up-to-date database is a no-op.
 */
export function runMigrations(db: Database.Database): void {
  const current = Number(db.pragma("user_version", { simple: true }));
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${MIGRATIONS.length})`,
    );
  }
  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i];
    if (sql === undefined) continue;
    const apply = db.transaction(() => {
      db.exec(sql);
      // PRAGMA cannot take bound parameters; `i` is our own integer, never user input.
      db.pragma(`user_version = ${i + 1}`);
    });
    apply();
  }
}
