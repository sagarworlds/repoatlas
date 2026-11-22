export { type BuiltDefinition, buildDefinitions, type DefinitionCandidate } from "./definitions.ts";
export { extractWithSpec, QuerySpecError, releaseSpec } from "./engine.ts";
export {
  buildLineIndex,
  classifyReceiver,
  collapseWhitespace,
  comparePositions,
  findEnclosingRanges,
  type IndexRange,
  positionAt,
  spanContains,
  stripQuotes,
  toSpan,
  truncateSignature,
} from "./helpers.ts";
export { buildImports } from "./imports.ts";
export { collectReferences, type ReferenceDraft } from "./references.ts";
export {
  type GrammarCheck,
  GrammarLoadError,
  initTreeSitter,
  loadGrammar,
  resolveRuntimeWasmPath,
  TreeSitterInitError,
  verifyGrammars,
} from "./runtime.ts";
export {
  DEFAULT_PARSE_TIMEOUT_MS,
  type ExtractOptions,
  type ReceiverTypeContext,
  type ScopeRules,
  type SyntaxNode,
  type SyntaxTree,
  type TreeSitterLanguageSpec,
} from "./types.ts";
