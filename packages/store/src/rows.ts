import type {
  Confidence,
  EdgeKind,
  EdgeMeta,
  GraphEdge,
  GraphNode,
  NodeKind,
  NodeMeta,
} from "@repoatlas/schema";
import type Database from "better-sqlite3";

export type Db = Database.Database;

// Prepared statements are cached per connection and SQL text.
const statementCache = new WeakMap<Db, Map<string, Database.Statement>>();

/** Returns a cached prepared statement (better-sqlite3 statements are reusable). */
export function stmt(db: Db, sql: string): Database.Statement {
  let perDb = statementCache.get(db);
  if (!perDb) {
    perDb = new Map();
    statementCache.set(db, perDb);
  }
  let s = perDb.get(sql);
  if (!s) {
    s = db.prepare(sql);
    perDb.set(sql, s);
  }
  return s;
}

/** Comma-separated "?" list for `IN (...)` clauses. Only the count is interpolated. */
export function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(",");
}

/** Parses a JSON object column; returns undefined for null, bad JSON or non-objects. */
export function parseJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through: corrupt meta is treated as absent, it must not break a query
  }
  return undefined;
}

export interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  language: string | null;
  file: string | null;
  start_line: number | null;
  end_line: number | null;
  signature: string | null;
  parent_id: string | null;
  meta_json: string | null;
}

/** Column list for node rows; `alias` lets joins qualify the columns. */
export function nodeColumns(alias = "n"): string {
  return [
    "id",
    "kind",
    "name",
    "qualified_name",
    "language",
    "file",
    "start_line",
    "end_line",
    "signature",
    "parent_id",
    "meta_json",
  ]
    .map((c) => `${alias}.${c}`)
    .join(", ");
}

export function rowToNode(row: NodeRow): GraphNode {
  const node: GraphNode = { id: row.id, kind: row.kind as NodeKind, name: row.name };
  if (row.qualified_name !== null) node.qualifiedName = row.qualified_name;
  if (row.language !== null) node.language = row.language as GraphNode["language"];
  if (row.file !== null) node.file = row.file;
  if (row.start_line !== null && row.end_line !== null) {
    node.span = { startLine: row.start_line, endLine: row.end_line };
  }
  if (row.signature !== null) node.signature = row.signature;
  if (row.parent_id !== null) node.parentId = row.parent_id;
  const meta = parseJsonObject(row.meta_json);
  if (meta) node.meta = meta as NodeMeta;
  return node;
}

export interface EdgeRow {
  src: string;
  dst: string;
  kind: string;
  confidence: string;
  line: number | null;
  meta_json: string | null;
}

export const EDGE_COLUMNS = "src, dst, kind, confidence, line, meta_json";

export function rowToEdge(row: EdgeRow): GraphEdge {
  const edge: GraphEdge = {
    src: row.src,
    dst: row.dst,
    kind: row.kind as EdgeKind,
    confidence: row.confidence as Confidence,
  };
  if (row.line !== null) edge.line = row.line;
  const meta = parseJsonObject(row.meta_json);
  if (meta) edge.meta = meta as EdgeMeta;
  return edge;
}

export function getNodeRow(db: Db, analysisId: string, nodeId: string): GraphNode | undefined {
  const row = stmt(
    db,
    `SELECT ${nodeColumns("n")} FROM nodes n WHERE n.analysis_id = ? AND n.id = ?`,
  ).get(analysisId, nodeId) as NodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

/** Fetches nodes by id (chunked to stay below SQLite's variable limit). Missing ids are skipped. */
export function getNodesByIds(db: Db, analysisId: string, ids: readonly string[]): GraphNode[] {
  const out: GraphNode[] = [];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = stmt(
      db,
      `SELECT ${nodeColumns("n")} FROM nodes n WHERE n.analysis_id = ? AND n.id IN (${placeholders(chunk.length)})`,
    ).all(analysisId, ...chunk) as NodeRow[];
    for (const row of rows) out.push(rowToNode(row));
  }
  return out;
}
