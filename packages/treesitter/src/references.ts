import type { RawReference } from "@repoatlas/schema";
import type { QueryMatch } from "web-tree-sitter";
import { firstCapture, firstCaptureWithPrefix } from "./captures.ts";
import { classifyReceiver, collapseWhitespace, comparePositions } from "./helpers.ts";
import type { ScopeRules, SyntaxNode } from "./types.ts";

const REFERENCE_KINDS: readonly RawReference["kind"][] = [
  "call",
  "extends",
  "implements",
  "type",
  "instantiate",
];
const MAX_RECEIVER_TEXT = 200;

/** A reference before it is attached to its enclosing definition. */
export interface ReferenceDraft {
  reference: RawReference;
  /** The whole reference node (the capture named @reference.<kind>). */
  referenceNode: SyntaxNode;
  receiverNode: SyntaxNode | undefined;
  column: number;
}

/**
 * Turns reference-query matches into drafts. Capture conventions:
 *
 *   @reference.call | .extends | .implements | .type | .instantiate
 *                    the whole reference node (call expression, base-class expression...).
 *                    Its suffix is the RawReference kind.
 *   @name            the referenced name (callee identifier / base type name). Required.
 *   @receiver        optional: the object the name is accessed on (`x` in `x.save()`).
 *                    Becomes `receiver` text and, with scopes, `receiverKind`.
 *   @args            optional: the argument-list node; `argCount` = its named children
 *                    that are not comments.
 *
 * `line` is the line of the @name node. Matches without @name or with an unknown
 * reference suffix are ignored. When several patterns match the same reference node,
 * the draft that carries a receiver wins.
 */
export function collectReferences(
  matches: readonly QueryMatch[],
  scopes: Pick<ScopeRules, "selfNames" | "superNames">,
): ReferenceDraft[] {
  const byKey = new Map<string, ReferenceDraft>();
  for (const match of matches) {
    const tagged = firstCaptureWithPrefix(match, "reference.");
    if (tagged === undefined) continue;
    const kind = REFERENCE_KINDS.find((k) => k === tagged.suffix);
    const nameNode = firstCapture(match, "name");
    if (kind === undefined || nameNode === undefined) continue;
    const name = nameNode.text.trim();
    if (name === "") continue;

    const reference: RawReference = { line: nameNode.startPosition.row + 1, kind, name };
    const receiverNode = firstCapture(match, "receiver");
    if (receiverNode !== undefined) {
      const text = collapseWhitespace(receiverNode.text);
      reference.receiver =
        text.length > MAX_RECEIVER_TEXT ? text.slice(0, MAX_RECEIVER_TEXT) : text;
      reference.receiverKind = classifyReceiver(text, receiverNode.type, scopes);
    }
    const argsNode = firstCapture(match, "args");
    if (argsNode !== undefined) {
      reference.argCount = argsNode.namedChildren.filter((c) => c.type !== "comment").length;
    }

    const draft: ReferenceDraft = {
      reference,
      referenceNode: tagged.node,
      receiverNode,
      column: nameNode.startPosition.column,
    };
    const key = `${tagged.node.id}:${kind}:${name}:${nameNode.startIndex}`;
    const existing = byKey.get(key);
    if (
      existing === undefined ||
      (existing.receiverNode === undefined && receiverNode !== undefined)
    ) {
      byKey.set(key, draft);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    comparePositions(
      { line: a.reference.line, column: a.column, name: a.reference.name },
      { line: b.reference.line, column: b.column, name: b.reference.name },
    ),
  );
}
