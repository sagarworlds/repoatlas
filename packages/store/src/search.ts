import type { GraphNode, NodeKind } from "@repoatlas/schema";
import { type Db, type NodeRow, nodeColumns, placeholders, rowToNode, stmt } from "./rows.ts";
import type { SearchQuery } from "./types.ts";

const DEFAULT_KINDS: NodeKind[] = ["function", "method", "class", "file"];
const MIN_TRIGRAM_LENGTH = 3;

/** Escapes LIKE wildcards; used with `ESCAPE '\'`. */
function escapeLike(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Wraps user text as one FTS5 string literal. Inside double quotes FTS5 has no operators
 * (AND/OR/NEAR/*, parentheses, column filters are all inert); only `"` needs doubling.
 * With the trigram tokenizer a quoted phrase is a plain substring match.
 */
function toFtsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function stripControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x20) out += ch;
  }
  return out;
}

const DEGREE_SQL = `
  ((SELECT count(*) FROM edges e WHERE e.analysis_id = n.analysis_id AND e.src = n.id AND e.kind <> 'contains')
 + (SELECT count(*) FROM edges e WHERE e.analysis_id = n.analysis_id AND e.dst = n.id AND e.kind <> 'contains'))`;

/**
 * Substring search over `name` and `qualified_name`, case-insensitive.
 *
 * - 3+ characters: FTS5 trigram index (fast substring match).
 * - 1-2 characters: trigram cannot match, so a bound LIKE is used instead.
 * Ranking: exact name (0) > name prefix (1) > any other substring (2); ties by degree
 * (non-`contains` edges touching the node, descending) then name. Every user value is a
 * bound parameter; nothing user-controlled is concatenated into SQL.
 */
export function search(db: Db, analysisId: string, query: SearchQuery): GraphNode[] {
  // NUL and other control characters are never part of a name; a NUL would make FTS5 throw
  // ("unterminated string") because SQLite truncates bound text at it.
  const text = stripControlChars(query.q).trim();
  if (text === "") return [];
  const limit = Math.min(
    100,
    Math.max(1, Number.isFinite(query.limit) ? Math.trunc(query.limit) : 20),
  );
  const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : DEFAULT_KINDS;

  const likeAny = `%${escapeLike(text)}%`;
  const likePrefix = `${escapeLike(text)}%`;
  const rank = `CASE WHEN lower(n.name) = lower(?) THEN 0
                     WHEN n.name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END`;

  let matchClause: string;
  const matchParams: string[] = [];
  let from = "FROM nodes n";
  if ([...text].length >= MIN_TRIGRAM_LENGTH) {
    from = "FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid";
    matchClause = "nodes_fts MATCH ?";
    matchParams.push(toFtsPhrase(text));
  } else {
    matchClause = "(n.name LIKE ? ESCAPE '\\' OR n.qualified_name LIKE ? ESCAPE '\\')";
    matchParams.push(likeAny, likeAny);
  }

  const sql = `SELECT ${nodeColumns("n")}, ${rank} AS rank, ${DEGREE_SQL} AS degree
    ${from}
    WHERE ${matchClause} AND n.analysis_id = ? AND n.kind IN (${placeholders(kinds.length)})
    ORDER BY rank, degree DESC, n.name, n.id
    LIMIT ?`;
  const rows = stmt(db, sql).all(
    text,
    likePrefix,
    ...matchParams,
    analysisId,
    ...kinds,
    limit,
  ) as NodeRow[];
  return rows.map(rowToNode);
}
