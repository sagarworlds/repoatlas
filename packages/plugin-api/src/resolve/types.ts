import type { Confidence, FileExtraction, GraphNode, LanguageId } from "@repoatlas/schema";
import type { SymbolIndex } from "../types.ts";
import type { BindingMap } from "./bindings.ts";

/**
 * A SymbolIndex that may also accept super types. Core's mutable index satisfies this
 * structurally; plugin-api must not import core.
 */
export interface MutableSymbolIndexLike extends SymbolIndex {
  addSuperType?(subId: string, superId: string): void;
}

export type ResolutionStep =
  | "self"
  | "super"
  | "local"
  | "binding"
  | "same-scope"
  | "import-member"
  | "static"
  | "type-hint"
  | "type-name"
  | "name-match";

export type UnresolvedReason = "external" | "ambiguous" | "no-candidate";

export interface ResolvedTarget {
  nodeId: string;
  confidence: Confidence;
}

export interface ResolvedRef {
  targets: ResolvedTarget[];
  unresolved?: true;
  reason?: UnresolvedReason;
  /** Set when a class was called without a known constructor: emit `references`, not `calls`. */
  asReference?: true;
  /** Which algorithm step produced the result (useful in tests and debugging). */
  step?: ResolutionStep;
}

export interface ResolveContext {
  index: MutableSymbolIndexLike;
  /** filePath -> bindings of that file. */
  bindings: Map<string, BindingMap>;
  language: LanguageId;
  /** Extra names that are never name-matched (added to the shared stoplist). */
  stoplistExtra?: Iterable<string>;
  /** When true, `self.x()` found directly in the same class is `exact`. Default false. */
  exactSelf?: boolean;
  /** Constructor method names, e.g. ["__init__"]. Absent: class calls become references. */
  constructorNames?: string[];
  /** Plugin hook for same module/package lookup (Go: same directory, Java: same package). */
  sameScopeLookup?(name: string, extraction: FileExtraction): GraphNode[];
  /** Max depth when walking super types. Default 32. */
  maxInheritanceDepth?: number;
  /**
   * Super types recorded by `applySuperTypes` (subId -> superIds, insertion ordered).
   * Used in addition to `index.superTypesOf`, so an immutable index still works.
   */
  superTypes?: Map<string, string[]>;
}

export const DEFAULT_MAX_INHERITANCE_DEPTH = 32;
