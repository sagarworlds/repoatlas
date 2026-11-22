import type { FileExtraction, LanguageId } from "@repoatlas/schema";
import type { Node, Tree } from "web-tree-sitter";

// Re-exported so language packages (and the spec interface below) do not need to import
// web-tree-sitter directly. `SyntaxNode` is the name used in docs/LANGUAGE_PLUGINS.md.
export type SyntaxNode = Node;
export type SyntaxTree = Tree;

/** Name resolution rules for one language (see LANGUAGE_PLUGINS section 4). */
export interface ScopeRules {
  /** Node types that open a named scope, e.g. ["class_definition"]. A function whose
   *  nearest enclosing definition has one of these node types becomes a method. */
  containerTypes: string[];
  /** Receiver names meaning "the current object": ["self", "cls"] | ["this"]. */
  selfNames: string[];
  /** Receiver names meaning "the parent class": ["super"]. */
  superNames: string[];
}

/** What the engine gives `inferReceiverType` for one reference that has a receiver. */
export interface ReceiverTypeContext {
  /** The receiver expression node (the `x` in `x.save()`). */
  receiverNode: SyntaxNode;
  /** The whole reference node (the call expression). */
  referenceNode: SyntaxNode;
  /** The definition node (function/class) that encloses the reference, if any. */
  enclosingDefinitionNode: SyntaxNode | undefined;
  /** Root node of the file's syntax tree. */
  root: SyntaxNode;
  src: string;
}

/**
 * Everything a Tier-1 language contributes. The engine (`extractWithSpec`) is generic;
 * all language knowledge lives in this object. Capture-name conventions for the three
 * queries are documented in the package README and in `engine.ts`.
 */
export interface TreeSitterLanguageSpec {
  language: LanguageId;
  /** Absolute path to the grammar .wasm, or a function returning it (resolved lazily). */
  grammarWasm: string | (() => string);
  extensions: string[];
  queries: {
    /** Captures: @definition.class/.interface/.function/.method, @name. */
    definitions: string;
    /** Captures: @import, @import.module, @import.name, @import.alias, markers. May be "". */
    imports: string;
    /** Captures: @reference.call/.extends/.implements/.type/.instantiate, @name, @receiver, @args. */
    references: string;
  };
  scopes: ScopeRules;
  /** One-line signature for a definition node (the engine collapses whitespace and truncates). */
  signature(node: SyntaxNode, src: string): string | undefined;
  /**
   * Optional: type name a receiver obviously has (`u = User()` then `u.save()` gives "User").
   * Called for references whose receiverKind is not self/super. Becomes `receiverTypeHint`.
   */
  inferReceiverType?(ctx: ReceiverTypeContext): string | undefined;
  /** Language-specific fix-ups (e.g. Go receiver methods, Rust impl blocks). The tree is
   *  still alive when this runs; do not keep node references after returning. */
  postProcess?(ex: FileExtraction, tree: SyntaxTree, src: string): FileExtraction;
}

export interface ExtractOptions {
  /** Wall-clock budget for the whole file (parse + queries). Default 10000. */
  timeoutMs?: number;
}

export const DEFAULT_PARSE_TIMEOUT_MS = 10_000;
