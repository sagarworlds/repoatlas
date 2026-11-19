import type { GraphEdge, GraphNode, LanguageId, NodeMeta } from "@repoatlas/schema";
import { isStoplisted, MAX_NAME_MATCH_CANDIDATES } from "./stoplist.ts";
import type { SymbolIndex } from "./types.ts";

/**
 * Name-match fallback (LANGUAGE_PLUGINS §5 step 7). Returns the candidate nodes to link
 * with `name-match` edges: 1..3 same-language candidates, preferring methods when there
 * is a receiver and functions otherwise. Empty array means "record as unresolved".
 */
export function nameMatchCandidates(
  index: SymbolIndex,
  name: string,
  language: LanguageId,
  hasReceiver: boolean,
  stoplistExtra?: Iterable<string>,
): GraphNode[] {
  if (isStoplisted(name, stoplistExtra)) return [];
  const sameLanguage = (index.byShortName.get(name) ?? []).filter((n) => n.language === language);
  const callable = sameLanguage.filter((n) => n.kind === "function" || n.kind === "method");
  const preferredKind = hasReceiver ? "method" : "function";
  const preferred = callable.filter((n) => n.kind === preferredKind);
  const pool = preferred.length > 0 ? preferred : callable;
  return pool.length >= 1 && pool.length <= MAX_NAME_MATCH_CANDIDATES ? pool : [];
}

/** True when a file path looks like test code in most ecosystems (plugins may refine). */
export function looksLikeTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|specs)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /_test\.(py|go|rb)$/.test(path)
  );
}

export function isTestMeta(meta: NodeMeta | undefined): boolean {
  return meta?.isTest === true;
}

export function makeEdge(
  src: string,
  dst: string,
  kind: GraphEdge["kind"],
  confidence: GraphEdge["confidence"],
  line?: number,
): GraphEdge {
  return line === undefined ? { src, dst, kind, confidence } : { src, dst, kind, confidence, line };
}
