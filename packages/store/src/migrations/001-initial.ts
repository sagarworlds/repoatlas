/** Initial schema (ARCHITECTURE section 6). Plain SQL strings, applied by `runMigrations`. */
export const initialMigration = `
CREATE TABLE analyses (
  id               TEXT PRIMARY KEY,
  owner            TEXT NOT NULL,
  repo             TEXT NOT NULL,
  ref              TEXT NOT NULL,
  commit_sha       TEXT,
  analyzer_version TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  status           TEXT NOT NULL,
  phase            TEXT,
  progress_json    TEXT,
  stats_json       TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE INDEX idx_analyses_cache ON analyses (owner, repo, commit_sha, analyzer_version);
CREATE INDEX idx_analyses_inflight ON analyses (owner, repo, ref, status);
CREATE INDEX idx_analyses_created ON analyses (created_at);

-- Rowid table on purpose: the FTS table below reuses nodes.rowid as its own rowid.
CREATE TABLE nodes (
  analysis_id    TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT,
  language       TEXT,
  file           TEXT,
  start_line     INTEGER,
  end_line       INTEGER,
  signature      TEXT,
  parent_id      TEXT,
  meta_json      TEXT,
  is_test        INTEGER NOT NULL DEFAULT 0,
  loc            INTEGER,
  PRIMARY KEY (analysis_id, id)
);
CREATE INDEX idx_nodes_parent ON nodes (analysis_id, parent_id);
CREATE INDEX idx_nodes_file ON nodes (analysis_id, file);

CREATE TABLE edges (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  confidence  TEXT NOT NULL,
  line        INTEGER,
  meta_json   TEXT
);
CREATE INDEX idx_edges_src ON edges (analysis_id, src, kind);
CREATE INDEX idx_edges_dst ON edges (analysis_id, dst, kind);

CREATE TABLE rollups (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  level       TEXT NOT NULL,
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  weight      INTEGER NOT NULL
);
CREATE INDEX idx_rollups_src ON rollups (analysis_id, level, src);

CREATE TABLE unresolved (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  file        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL
);
CREATE INDEX idx_unresolved_analysis ON unresolved (analysis_id);

-- Trigram tokenizer: any 3+ character query is a case-insensitive substring match.
-- Rows are keyed by nodes.rowid (no triggers: the store inserts and deletes them explicitly).
CREATE VIRTUAL TABLE nodes_fts USING fts5(name, qualified_name, tokenize = 'trigram');
`;
