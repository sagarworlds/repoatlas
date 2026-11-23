/**
 * Per-file extraction cache (core: pipeline/extraction-cache.ts). `key` is a sha256 hex of
 * everything that influences the extraction; `data` is the JSON of a FileExtraction.
 * `size` is the byte length of `data`, `last_used` is epoch milliseconds (for eviction).
 */
export const extractionCacheMigration = `
CREATE TABLE extraction_cache (
  key       TEXT PRIMARY KEY,
  data      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  last_used INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_extraction_cache_last_used ON extraction_cache (last_used);
`;
