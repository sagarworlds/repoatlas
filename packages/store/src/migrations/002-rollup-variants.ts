/**
 * Rollup rows come in variants (tests included or not, minimum edge confidence) so that
 * `includeTests` and `minConfidence` also work at dir and file level. Existing rows are the
 * default variant (everything counted).
 */
export const rollupVariantsMigration = `
ALTER TABLE rollups ADD COLUMN include_tests INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rollups ADD COLUMN min_confidence TEXT NOT NULL DEFAULT 'name-match';
`;
