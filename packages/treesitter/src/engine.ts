import type { Definition, FileExtraction, RawReference } from "@repoatlas/schema";
import { type Language, Parser, Query, type QueryMatch } from "web-tree-sitter";
import { firstCapture, firstCaptureWithPrefix } from "./captures.ts";
import { buildDefinitions, type DefinitionCandidate } from "./definitions.ts";
import { findEnclosingRanges, toSpan, truncateSignature } from "./helpers.ts";
import { buildImports } from "./imports.ts";
import { collectReferences } from "./references.ts";
import { initTreeSitter, loadGrammar } from "./runtime.ts";
import {
  DEFAULT_PARSE_TIMEOUT_MS,
  type ExtractOptions,
  type SyntaxNode,
  type SyntaxTree,
  type TreeSitterLanguageSpec,
} from "./types.ts";

/** Thrown when a spec's .scm query does not compile: a bug in the spec, not in the input. */
export class QuerySpecError extends Error {
  readonly code = "QUERY_SPEC_INVALID";
  constructor(language: string, which: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Invalid ${which} query for language ${language}: ${reason}`, { cause });
    this.name = "QuerySpecError";
  }
}

interface Compiled {
  parser: Parser;
  definitions: Query;
  imports: Query | undefined;
  references: Query;
}

// One compiled bundle per spec object. Bounded (one per language), so no growth per file.
const compiledBySpec = new WeakMap<TreeSitterLanguageSpec, Compiled>();

function compileQuery(
  language: Language,
  spec: TreeSitterLanguageSpec,
  which: string,
  src: string,
): Query {
  try {
    return new Query(language, src);
  } catch (cause) {
    throw new QuerySpecError(spec.language, which, cause);
  }
}

function getCompiled(spec: TreeSitterLanguageSpec, language: Language): Compiled {
  const existing = compiledBySpec.get(spec);
  if (existing !== undefined) return existing;
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    const compiled: Compiled = {
      parser,
      definitions: compileQuery(language, spec, "definitions", spec.queries.definitions),
      imports:
        spec.queries.imports.trim() === ""
          ? undefined
          : compileQuery(language, spec, "imports", spec.queries.imports),
      references: compileQuery(language, spec, "references", spec.queries.references),
    };
    compiledBySpec.set(spec, compiled);
    return compiled;
  } catch (error) {
    parser.delete();
    throw error;
  }
}

/** Frees the parser and queries cached for a spec (tests; normal runs keep them). */
export function releaseSpec(spec: TreeSitterLanguageSpec): void {
  const compiled = compiledBySpec.get(spec);
  if (compiled === undefined) return;
  compiled.definitions.delete();
  compiled.imports?.delete();
  compiled.references.delete();
  compiled.parser.delete();
  compiledBySpec.delete(spec);
}

function emptyExtraction(
  spec: TreeSitterLanguageSpec,
  path: string,
  parseErrors: number,
  meta: Record<string, unknown>,
): FileExtraction {
  return {
    file: path,
    language: spec.language,
    definitions: [],
    imports: [],
    references: [],
    parseErrors,
    meta,
  };
}

/** Counts ERROR and MISSING nodes, descending only into subtrees that contain an error. */
function countParseErrors(tree: SyntaxTree): number {
  const cursor = tree.walk();
  let count = 0;
  try {
    const visit = (): void => {
      const node = cursor.currentNode;
      if (!node.hasError) return;
      if (node.isError || node.isMissing) count++;
      if (cursor.gotoFirstChild()) {
        do visit();
        while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    visit();
  } finally {
    cursor.delete();
  }
  return count;
}

function collectDefinitionCandidates(
  matches: readonly QueryMatch[],
  spec: TreeSitterLanguageSpec,
  src: string,
): { candidates: DefinitionCandidate[]; nodes: SyntaxNode[] } {
  const seen = new Map<number, number>(); // node id -> index in candidates
  const candidates: DefinitionCandidate[] = [];
  const nodes: SyntaxNode[] = [];
  const kinds = ["class", "interface", "function", "method"] as const;
  for (const match of matches) {
    const tagged = firstCaptureWithPrefix(match, "definition.");
    const nameNode = firstCapture(match, "name");
    const kind = kinds.find((k) => k === tagged?.suffix);
    if (tagged === undefined || nameNode === undefined || kind === undefined) continue;
    const name = nameNode.text.trim();
    if (name === "") continue;
    const node = tagged.node;
    const earlier = seen.get(node.id);
    if (earlier !== undefined) {
      const prior = candidates[earlier];
      if (prior !== undefined && kind === "method") prior.kind = "method";
      continue;
    }
    const { startLine, endLine } = toSpan(
      node.startPosition.row,
      node.endPosition.row,
      node.endPosition.column,
    );
    const candidate: DefinitionCandidate = {
      kind,
      name,
      nodeType: node.type,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      startLine,
      endLine,
    };
    const sig = spec.signature(node, src);
    if (sig !== undefined && sig.trim() !== "") candidate.signature = truncateSignature(sig);
    seen.set(node.id, candidates.length);
    candidates.push(candidate);
    nodes.push(node);
  }
  return { candidates, nodes };
}

/**
 * The generic Tier-1 extractor. Parse (with a time budget) -> definitions -> imports ->
 * references -> optional spec.postProcess. Never throws for bad syntax or slow input:
 * a timeout or a parser failure yields an empty extraction with parseErrors 1 and meta
 * `{ timedOut: true }` / `{ parseFailed: true }`. It does throw for configuration bugs
 * (GrammarLoadError, TreeSitterInitError, QuerySpecError).
 *
 * Capture-name conventions are documented in the README and in imports.ts / references.ts;
 * definitions use @definition.class|interface|function|method on the whole definition node
 * and @name on its name.
 */
export async function extractWithSpec(
  spec: TreeSitterLanguageSpec,
  file: { path: string; content: string },
  options: ExtractOptions = {},
): Promise<FileExtraction> {
  await initTreeSitter();
  const wasmPath = typeof spec.grammarWasm === "function" ? spec.grammarWasm() : spec.grammarWasm;
  const language = await loadGrammar(wasmPath);
  const compiled = getCompiled(spec, language);
  const src = file.content;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS);
  const expired = (): boolean => Date.now() > deadline;

  let tree: SyntaxTree | null;
  try {
    tree = compiled.parser.parse(src, null, { progressCallback: expired });
  } catch (error) {
    compiled.parser.reset();
    return emptyExtraction(spec, file.path, 1, {
      parseFailed: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (tree === null) {
    compiled.parser.reset(); // drop the half-finished parse state
    return emptyExtraction(spec, file.path, 1, { timedOut: true });
  }

  try {
    const result = extractFromTree(spec, compiled, tree, file.path, src, expired);
    return result ?? emptyExtraction(spec, file.path, 1, { timedOut: true });
  } finally {
    tree.delete();
  }
}

function extractFromTree(
  spec: TreeSitterLanguageSpec,
  compiled: Compiled,
  tree: SyntaxTree,
  path: string,
  src: string,
  expired: () => boolean,
): FileExtraction | undefined {
  const root = tree.rootNode;
  // Query progress callbacks return true to cancel; the type says void, a boolean is allowed.
  const queryOptions = { progressCallback: expired };

  const parseErrors = countParseErrors(tree);
  const defMatches = compiled.definitions.matches(root, queryOptions);
  if (expired()) return undefined;
  const { candidates, nodes } = collectDefinitionCandidates(defMatches, spec, src);
  const built = buildDefinitions(candidates, spec.scopes.containerTypes);
  const definitions: Definition[] = built.map((b) => b.definition);

  const importMatches = compiled.imports?.matches(root, queryOptions) ?? [];
  if (expired()) return undefined;
  const imports = buildImports(importMatches);

  const refMatches = compiled.references.matches(root, queryOptions);
  if (expired()) return undefined;
  const drafts = collectReferences(refMatches, spec.scopes);

  // Attach each reference to the innermost enclosing definition (by node span).
  const ranges = built.map((b) => {
    const c = candidates[b.candidateIndex] as DefinitionCandidate;
    return { startIndex: c.startIndex, endIndex: c.endIndex };
  });
  const enclosing = findEnclosingRanges(
    ranges,
    drafts.map((d) => d.referenceNode.startIndex),
  );
  let outOfTime = false;
  const references: RawReference[] = drafts.map((draft, i) => {
    const reference = draft.reference;
    const owner = enclosing[i] ?? -1;
    const ownerBuilt = owner >= 0 ? built[owner] : undefined;
    if (ownerBuilt !== undefined) reference.fromLocalId = ownerBuilt.definition.localId;
    // The deadline also covers receiver-type inference (checked every 64 references).
    if (i % 64 === 0 && expired()) outOfTime = true;
    const needsHint =
      !outOfTime &&
      spec.inferReceiverType !== undefined &&
      draft.receiverNode !== undefined &&
      reference.receiverKind !== "self" &&
      reference.receiverKind !== "super";
    if (needsHint && spec.inferReceiverType !== undefined && draft.receiverNode !== undefined) {
      const hint = spec.inferReceiverType({
        receiverNode: draft.receiverNode,
        referenceNode: draft.referenceNode,
        enclosingDefinitionNode:
          ownerBuilt === undefined ? undefined : nodes[ownerBuilt.candidateIndex],
        root,
        src,
      });
      if (hint !== undefined && hint !== "") reference.receiverTypeHint = hint;
    }
    return reference;
  });

  if (outOfTime || expired()) return undefined;

  let extraction: FileExtraction = {
    file: path,
    language: spec.language,
    definitions,
    imports,
    references,
    parseErrors,
  };
  if (spec.postProcess !== undefined) extraction = spec.postProcess(extraction, tree, src);
  return expired() ? undefined : extraction;
}
