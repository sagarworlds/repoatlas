import type { QueryMatch } from "web-tree-sitter";
import type { SyntaxNode } from "./types.ts";

/** All captured nodes with exactly this capture name (without the leading "@"). */
export function capturesNamed(match: QueryMatch, name: string): SyntaxNode[] {
  return match.captures.filter((c) => c.name === name).map((c) => c.node);
}

export function firstCapture(match: QueryMatch, name: string): SyntaxNode | undefined {
  return match.captures.find((c) => c.name === name)?.node;
}

/** First capture whose name starts with `prefix` (e.g. "reference."), with the suffix. */
export function firstCaptureWithPrefix(
  match: QueryMatch,
  prefix: string,
): { suffix: string; node: SyntaxNode } | undefined {
  for (const c of match.captures) {
    if (c.name.startsWith(prefix)) return { suffix: c.name.slice(prefix.length), node: c.node };
  }
  return undefined;
}
