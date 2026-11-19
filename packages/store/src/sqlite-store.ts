import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  AnalysisStatsSchema,
  type AnalysisStatus,
  type GraphNode,
  ProgressSchema,
  SCHEMA_VERSION,
} from "@repoatlas/schema";
import Database from "better-sqlite3";
import { getCallflow, getDeps, getNodeDetail } from "./graph-queries.ts";
import { runMigrations } from "./migrations/index.ts";
import { type Db, getNodeRow, type NodeRow, nodeColumns, rowToNode, stmt } from "./rows.ts";
import { search } from "./search.ts";
import { clearLocCache, getSubgraph } from "./subgraph.ts";
import type { AnalysisPatch, AnalysisRecord, GraphData, GraphStore, NewAnalysis } from "./types.ts";

interface AnalysisRow {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  commit_sha: string | null;
  analyzer_version: string;
  status: string;
  progress_json: string | null;
  stats_json: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const ANALYSIS_COLUMNS =
  "id, owner, repo, ref, commit_sha, analyzer_version, status, progress_json, stats_json, error, created_at, finished_at";

const UNFINISHED_SQL = "status NOT IN ('done', 'failed')";

/** Parses stored JSON and validates it with zod (a corrupt row throws a clear error). */
function readJson<T>(text: string | null, parse: (value: unknown) => T, what: string): T | null {
  if (text === null) return null;
  try {
    return parse(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `Corrupt ${what} in database: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function rowToAnalysis(row: AnalysisRow): AnalysisRecord {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    ref: row.ref,
    commitSha: row.commit_sha,
    analyzerVersion: row.analyzer_version,
    status: row.status as AnalysisStatus,
    progress: readJson(row.progress_json, (v) => ProgressSchema.parse(v), "progress_json"),
    stats: readJson(row.stats_json, (v) => AnalysisStatsSchema.parse(v), "stats_json"),
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Opens (and migrates) the SQLite store. `location` is a file path or ":memory:".
 * Missing parent directories of a file path are created.
 */
export function openStore(location: string): GraphStore {
  const inMemory = location === ":memory:";
  if (!inMemory) mkdirSync(dirname(location), { recursive: true });
  const db = new Database(location);
  try {
    if (!inMemory) {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
    }
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new SqliteStore(db);
}

class SqliteStore implements GraphStore {
  constructor(private readonly db: Db) {}

  private queryAnalyses(sql: string, ...params: unknown[]): AnalysisRecord[] {
    const rows = stmt(this.db, sql).all(...params) as AnalysisRow[];
    return rows.map(rowToAnalysis);
  }

  private oneAnalysis(sql: string, ...params: unknown[]): AnalysisRecord | undefined {
    return this.queryAnalyses(sql, ...params)[0];
  }

  createAnalysis(input: NewAnalysis): AnalysisRecord {
    const createdAt = new Date().toISOString();
    stmt(
      this.db,
      `INSERT INTO analyses (id, owner, repo, ref, analyzer_version, schema_version, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      input.id,
      input.owner,
      input.repo,
      input.ref,
      input.analyzerVersion,
      SCHEMA_VERSION,
      createdAt,
    );
    const created = this.getAnalysis(input.id);
    if (!created) throw new Error("createAnalysis: row missing after insert");
    return created;
  }

  /** Patch semantics: only keys present (and not undefined) are written; null clears a column. */
  updateAnalysis(id: string, patch: AnalysisPatch): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    // Column names below are fixed literals, never taken from the patch object.
    const add = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.commitSha !== undefined) add("commit_sha", patch.commitSha);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.progress !== undefined) {
      add("progress_json", patch.progress === null ? null : JSON.stringify(patch.progress));
      add("phase", patch.progress === null ? null : patch.progress.phase);
    }
    if (patch.stats !== undefined) {
      add("stats_json", patch.stats === null ? null : JSON.stringify(patch.stats));
    }
    if (patch.error !== undefined) add("error", patch.error);
    if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt);
    if (sets.length === 0) return;
    stmt(this.db, `UPDATE analyses SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  }

  getAnalysis(id: string): AnalysisRecord | undefined {
    return this.oneAnalysis(`SELECT ${ANALYSIS_COLUMNS} FROM analyses WHERE id = ?`, id);
  }

  findCached(
    owner: string,
    repo: string,
    commitSha: string,
    analyzerVersion: string,
  ): AnalysisRecord | undefined {
    return this.oneAnalysis(
      `SELECT ${ANALYSIS_COLUMNS} FROM analyses
       WHERE owner = ? AND repo = ? AND commit_sha = ? AND analyzer_version = ? AND status = 'done'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      owner,
      repo,
      commitSha,
      analyzerVersion,
    );
  }

  findInFlight(owner: string, repo: string, ref: string): AnalysisRecord | undefined {
    return this.oneAnalysis(
      `SELECT ${ANALYSIS_COLUMNS} FROM analyses
       WHERE owner = ? AND repo = ? AND ref = ? AND ${UNFINISHED_SQL}
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      owner,
      repo,
      ref,
    );
  }

  listAnalyses(limit: number): AnalysisRecord[] {
    return this.queryAnalyses(
      `SELECT ${ANALYSIS_COLUMNS} FROM analyses ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      Math.max(0, Math.trunc(limit)),
    );
  }

  listUnfinished(): AnalysisRecord[] {
    return this.queryAnalyses(
      `SELECT ${ANALYSIS_COLUMNS} FROM analyses WHERE ${UNFINISHED_SQL} ORDER BY created_at, rowid`,
    );
  }

  /** Oldest finished (`done` or `failed`) analyses beyond the newest `keep`, oldest first. */
  listEvictable(keep: number): AnalysisRecord[] {
    return this.queryAnalyses(
      `SELECT ${ANALYSIS_COLUMNS} FROM analyses WHERE status IN ('done', 'failed')
       ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      Math.max(0, Math.trunc(keep)),
    ).reverse();
  }

  /**
   * Replaces the graph of `id` in ONE transaction. `db.transaction(fn)` returns a function
   * that commits when `fn` returns and rolls back when it throws (like TransactionScope).
   */
  saveGraph(id: string, data: GraphData): void {
    const db = this.db;
    const run = db.transaction(() => {
      this.clearGraph(id);
      const insNode = stmt(
        db,
        `INSERT INTO nodes (analysis_id, id, kind, name, qualified_name, language, file,
           start_line, end_line, signature, parent_id, meta_json, is_test, loc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insFts = stmt(
        db,
        "INSERT INTO nodes_fts (rowid, name, qualified_name) VALUES (?, ?, ?)",
      );
      for (const n of data.nodes) {
        const info = insNode.run(
          id,
          n.id,
          n.kind,
          n.name,
          n.qualifiedName ?? null,
          n.language ?? null,
          n.file ?? null,
          n.span?.startLine ?? null,
          n.span?.endLine ?? null,
          n.signature ?? null,
          n.parentId ?? null,
          n.meta ? JSON.stringify(n.meta) : null,
          n.meta?.isTest === true ? 1 : 0,
          n.meta?.loc ?? null,
        );
        if (n.kind !== "repo") {
          insFts.run(info.lastInsertRowid, n.name, n.qualifiedName ?? "");
        }
      }
      const insEdge = stmt(
        db,
        `INSERT INTO edges (analysis_id, src, dst, kind, confidence, line, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of data.edges) {
        insEdge.run(
          id,
          e.src,
          e.dst,
          e.kind,
          e.confidence,
          e.line ?? null,
          e.meta ? JSON.stringify(e.meta) : null,
        );
      }
      const insRollup = stmt(
        db,
        `INSERT INTO rollups (analysis_id, level, src, dst, kind, weight, include_tests, min_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of data.rollups) {
        const includeTests = r.includeTests === false ? 0 : 1;
        const minConfidence = r.minConfidence ?? "name-match";
        insRollup.run(id, r.level, r.src, r.dst, r.kind, r.weight, includeTests, minConfidence);
      }
      const insUnresolved = stmt(
        db,
        "INSERT INTO unresolved (analysis_id, file, line, name, kind) VALUES (?, ?, ?, ?, ?)",
      );
      for (const u of data.unresolved) insUnresolved.run(id, u.file, u.line, u.name, u.kind);
    });
    try {
      run();
    } finally {
      clearLocCache(db, id);
    }
  }

  /** Removes graph rows of one analysis (the analyses row stays). FTS rows are not cascaded. */
  private clearGraph(id: string): void {
    const db = this.db;
    stmt(
      db,
      "DELETE FROM nodes_fts WHERE rowid IN (SELECT rowid FROM nodes WHERE analysis_id = ?)",
    ).run(id);
    for (const table of ["nodes", "edges", "rollups", "unresolved"]) {
      stmt(db, `DELETE FROM ${table} WHERE analysis_id = ?`).run(id);
    }
  }

  deleteAnalysis(id: string): void {
    const run = this.db.transaction(() => {
      this.clearGraph(id);
      stmt(this.db, "DELETE FROM analyses WHERE id = ?").run(id); // cascades as a safety net
    });
    try {
      run();
    } finally {
      clearLocCache(this.db, id);
    }
  }

  getNode(id: string, nodeId: string): GraphNode | undefined {
    return getNodeRow(this.db, id, nodeId);
  }

  getFileNode(id: string, path: string): GraphNode | undefined {
    const row = stmt(
      this.db,
      `SELECT ${nodeColumns("n")} FROM nodes n WHERE n.analysis_id = ? AND n.kind = 'file' AND n.file = ?`,
    ).get(id, path) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  getSubgraph: GraphStore["getSubgraph"] = (id, query) => getSubgraph(this.db, id, query);
  getNodeDetail: GraphStore["getNodeDetail"] = (id, nodeId) => getNodeDetail(this.db, id, nodeId);
  getCallflow: GraphStore["getCallflow"] = (id, nodeId, up, down) =>
    getCallflow(this.db, id, nodeId, up, down);
  getDeps: GraphStore["getDeps"] = (id, filePath, direction, depth) =>
    getDeps(this.db, id, filePath, direction, depth);
  search: GraphStore["search"] = (id, query) => search(this.db, id, query);

  close(): void {
    this.db.close();
  }
}
