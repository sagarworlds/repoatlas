import { MAX_SIGNATURE_LENGTH, type RawReference, type Span } from "@repoatlas/schema";
import type { ScopeRules } from "./types.ts";

type ReceiverKind = NonNullable<RawReference["receiverKind"]>;

/**
 * Pure helpers shared by the engine and by language plugins. None of them touch WASM,
 * so they are unit-tested with plain data.
 */

// ---- spans and positions -------------------------------------------------------------

/**
 * Converts tree-sitter's 0-based start/end rows into a 1-based inclusive line span.
 * A node that ends at column 0 of a later row (it swallowed the trailing newline) does
 * not really occupy that last row, so the end line is pulled back by one.
 */
export function toSpan(
  startRow: number,
  endRow: number,
  endColumn: number,
): { startLine: number; endLine: number } {
  const endsAtLineStart = endColumn === 0 && endRow > startRow;
  return { startLine: startRow + 1, endLine: (endsAtLineStart ? endRow - 1 : endRow) + 1 };
}

export function spanContains(outer: Span, inner: Span): boolean {
  return outer.startLine <= inner.startLine && inner.endLine <= outer.endLine;
}

/** Offsets (UTF-16 indexes) at which each line starts. Line 1 starts at index 0. */
export function buildLineIndex(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line and 0-based column of a UTF-16 offset, via binary search on a line index. */
export function positionAt(
  lineIndex: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineIndex[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (lineIndex[lo] ?? 0) };
}

// ---- text utilities ------------------------------------------------------------------

/** Collapses every whitespace run (including newlines) to a single space and trims. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapses whitespace and truncates to `max` characters (the last one becomes an ellipsis). */
export function truncateSignature(text: string, max: number = MAX_SIGNATURE_LENGTH): string {
  const flat = collapseWhitespace(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Removes one pair of matching surrounding quotes: 'x' "x" `x`. Other text is unchanged. */
export function stripQuotes(text: string): string {
  const first = text[0];
  if (
    text.length >= 2 &&
    (first === '"' || first === "'" || first === "`") &&
    text.at(-1) === first
  ) {
    return text.slice(1, -1);
  }
  return text;
}

// ---- receiver classification ---------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MEMBER_CHAIN = /^[A-Za-z_$][\w$]*(?:\s*(?:\.|::|->|\?\.)\s*[A-Za-z_$][\w$]*)+$/;
const CALL_LIKE = /^([A-Za-z_$][\w$]*)\s*\(.*\)$/s;

/**
 * Classifies the receiver of a call (`recv.name()`), using the language's scope rules.
 *   self          receiver text is one of scopes.selfNames
 *   super         receiver text is one of superNames, or a call of one (`super()`)
 *   identifier    a single plain name (`utils`, `User`, `x`)
 *   member-chain  `a.b.c` style access
 *   call          the receiver is itself a call result (`get_user().save()`)
 *   other         anything else (literals, subscripts, parenthesised expressions)
 * `nodeType` is the tree-sitter node type of the receiver, used only as a hint when the
 * text alone is ambiguous.
 */
export function classifyReceiver(
  text: string,
  nodeType: string | undefined,
  scopes: Pick<ScopeRules, "selfNames" | "superNames">,
): ReceiverKind {
  const trimmed = text.trim();
  if (trimmed === "") return "other";
  if (scopes.selfNames.includes(trimmed)) return "self";
  if (scopes.superNames.includes(trimmed)) return "super";
  const callMatch = CALL_LIKE.exec(trimmed);
  if (callMatch !== null) {
    const callee = callMatch[1] ?? "";
    return scopes.superNames.includes(callee) ? "super" : "call";
  }
  if (IDENTIFIER.test(trimmed)) return "identifier";
  if (MEMBER_CHAIN.test(trimmed)) return "member-chain";
  if (nodeType?.includes("call")) return "call";
  return "other";
}

// ---- enclosing-definition attachment -------------------------------------------------

export interface IndexRange {
  /** Inclusive start offset. */
  startIndex: number;
  /** Exclusive end offset. */
  endIndex: number;
}

/**
 * For each offset, returns the index (into `ranges`) of the innermost range that contains
 * it (start <= offset < end), or -1 when none does. Ranges must be properly nested or
 * disjoint, as syntax-tree nodes are. Runs in O((R + P) log) using a sorted sweep with a
 * stack instead of testing every pair.
 */
export function findEnclosingRanges(
  ranges: readonly IndexRange[],
  offsets: readonly number[],
): number[] {
  const rangeOrder = ranges
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = ranges[a] as IndexRange;
      const rb = ranges[b] as IndexRange;
      return ra.startIndex - rb.startIndex || rb.endIndex - ra.endIndex || a - b;
    });
  const pointOrder = offsets
    .map((_, i) => i)
    .sort((a, b) => (offsets[a] ?? 0) - (offsets[b] ?? 0) || a - b);
  const result: number[] = new Array<number>(offsets.length).fill(-1);
  const stack: number[] = [];
  let next = 0;
  for (const p of pointOrder) {
    const offset = offsets[p] ?? 0;
    while (next < rangeOrder.length) {
      const candidate = rangeOrder[next] as number;
      if ((ranges[candidate] as IndexRange).startIndex > offset) break;
      stack.push(candidate);
      next++;
    }
    while (stack.length > 0 && (ranges[stack.at(-1) as number] as IndexRange).endIndex <= offset) {
      stack.pop();
    }
    result[p] = stack.length > 0 ? (stack.at(-1) as number) : -1;
  }
  return result;
}

/** Generic stable comparator: line, then column, then name. */
export function comparePositions(
  a: { line: number; column: number; name: string },
  b: { line: number; column: number; name: string },
): number {
  return a.line - b.line || a.column - b.column || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
