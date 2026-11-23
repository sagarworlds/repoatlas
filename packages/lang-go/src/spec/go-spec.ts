import type { TreeSitterLanguageSpec } from "@repoatlas/treesitter";
import { postProcessGo } from "../extract/post-process.ts";
import { goGrammarPath } from "../grammar.ts";
import { loadGoQueries } from "./queries.ts";
import { inferGoReceiverType } from "./receiver-type.ts";
import { goSignature } from "./signature.ts";

/**
 * The Go language spec for the generic tree-sitter engine. The engine caches its compiled
 * parser and queries per spec object, so always use this one instance.
 *
 * `containerTypes` is empty: Go has no nesting of definitions (methods are top-level and are
 * attached to their receiver type in postProcess). `selfNames` is empty because the receiver
 * variable name differs per method (`s`, `srv`, ...); postProcess sets receiverKind "self".
 */
export const goSpec: TreeSitterLanguageSpec = {
  language: "go",
  grammarWasm: () => goGrammarPath(),
  extensions: [".go"],
  queries: loadGoQueries(),
  scopes: { containerTypes: [], selfNames: [], superNames: [] },
  signature: (node) => goSignature(node),
  inferReceiverType: inferGoReceiverType,
  postProcess: postProcessGo,
};
