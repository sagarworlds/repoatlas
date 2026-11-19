# Graph Schema (the core contract)

Everything in RepoAtlas — plugins, store, API, UI — speaks this schema. It lives in
`packages/schema` as TypeScript types **plus** matching `zod` schemas, and exports ID
helper functions. `SCHEMA_VERSION = 1`.

## 1. Nodes

```ts
export type NodeKind =
  | "repo"        // one per analysis
  | "directory"
  | "file"
  | "module"      // a language-level module/package/namespace not identical to a file
                  // (Go package, Java package, C# namespace, Rust mod). Optional per language.
  | "class"       // class, struct, record, enum, trait/mixin-as-class
  | "interface"   // interface, protocol, trait (when it is a contract)
  | "function"    // top-level/free function
  | "method"      // function owned by a class/interface/struct (incl. constructors)
  | "external";   // a third-party package or unresolved external module

export interface GraphNode {
  id: string;                 // stable ID, see §3
  kind: NodeKind;
  name: string;               // short display name: "save", "User", "models.py"
  qualifiedName?: string;     // language-qualified: "app.models.User.save"
  language?: LanguageId;      // absent for repo/directory
  file?: string;              // repo-relative POSIX path, for file and symbol nodes
  span?: { startLine: number; endLine: number };   // 1-based, inclusive
  signature?: string;         // one-line signature, max 300 chars, e.g. "save(self, force: bool = False) -> None"
  parentId?: string;          // structural parent (dir, file, class); must match a `contains` edge
  meta?: NodeMeta;
}

export interface NodeMeta {
  visibility?: "public" | "protected" | "private" | "internal";
  isStatic?: boolean;
  isAsync?: boolean;
  isExported?: boolean;
  isTest?: boolean;           // file/symbol detected as test code; a directory holding only test files
  parseErrors?: number;       // file nodes: count of syntax errors (set by core when > 0)
  isGenerated?: boolean;
  ecosystem?: string;         // for external: "npm" | "node" | "pypi" | "go" | "maven" | "nuget" | "crates" | "composer" | "rubygems"
  loc?: number;               // lines of code (files and symbols)
  [key: string]: unknown;     // plugins may add namespaced keys: "py.decorators", "go.receiver"
}

export type LanguageId =
  | "typescript" | "javascript" | "python" | "go" | "java" | "kotlin"
  | "csharp" | "rust" | "php" | "ruby" | "c" | "cpp";
```

## 2. Edges

```ts
export type EdgeKind =
  | "contains"    // structural: repo→dir, dir→dir, dir→file, file→symbol, class→method
  | "imports"     // file → file | module | external
  | "calls"       // function/method → function/method (at a call site)
  | "extends"     // class → class, interface → interface
  | "implements"  // class → interface
  | "references"; // symbol → symbol, non-call use (type usage, passing a function, instantiation if not modeled as call)

export type Confidence =
  | "exact"       // resolved by a compiler/type checker or unambiguous static rule
  | "inferred"    // resolved via scope + import analysis heuristics; very likely right
  | "name-match"; // matched only by name; may be wrong. UI shows as dashed.

export interface GraphEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: Confidence;     // "contains" is always "exact"
  line?: number;              // line of the call/import site in src's file
  meta?: {
    alias?: string;           // import alias: `import numpy as np` → "np"
    importedNames?: string[]; // `from x import a, b`
    isDynamic?: boolean;      // dynamic import / reflection / getattr
    callCount?: number;       // when one src calls dst multiple times, merge into one edge
    [key: string]: unknown;
  };
}
```

Rules:
- **Merge duplicate edges**: same `(src, dst, kind)` → one edge, `meta.callCount++`,
  keep the first `line`, store all lines in `meta.lines` (cap 50). Keep the **highest**
  confidence seen.
- Constructor calls (`new User()`, `User()` in Python) → `calls` edge to the
  constructor method if one exists, else `references` edge to the class.
- Calls from top-level/module code: `src` is the **file** node. So is code that runs
  directly in a class body (static property initializers, accessors that are not nodes):
  a `calls` edge never starts at a class.
- `new Derived()` where `Derived` has no own constructor: `references` edge to `Derived`
  (the inherited base constructor is not the target).
- Core owns `contains` edges; plugin-emitted `contains` edges are dropped.
- Never emit an edge whose `src` or `dst` is not a node in the same analysis
  (the core validates this; violations are dropped and counted in stats).
- `name-match` edges are only emitted when the candidate set is small
  (≤ 3 candidates); with 2–3 candidates emit one edge per candidate, all `name-match`.
  With more, record as unresolved instead.

## 3. Node IDs

IDs must be **stable across runs** for the same commit and **deterministic**.
Always POSIX paths relative to repo root. Build them only via helpers in `schema/ids.ts`.

| Kind | Format | Example |
|---|---|---|
| repo | `repo:` | `repo:` |
| directory | `dir:{path}` | `dir:src/app` (root dir is `dir:`) |
| file | `file:{path}` | `file:src/app/models.py` |
| module | `mod:{lang}:{qualified}` | `mod:go:github.com/acme/api/server` |
| symbol | `sym:{path}#{qualifiedInFile}` | `sym:src/app/models.py#User.save` |
| external | `ext:{ecosystem}:{package}` | `ext:pypi:requests`, `ext:npm:@scope/pkg`, `ext:node:builtins` |

All Node.js built-ins (`fs`, `node:path`, ...) collapse into the single external
`ext:node:builtins`; the `imports` edge carries `meta.package` / `meta.packages`.
File and directory nodes exist only for files a plugin claimed (plus non-source files an
edge points at); see DECISIONS D9.

`qualifiedInFile` = the dotted chain of enclosing class/namespace names *within the
file*, then the symbol name. Disambiguate collisions (overloads, redefinitions,
partial declarations) by appending `@{startLine}` to the later ones:
`sym:src/Foo.java#Foo.bar@42`. Anonymous functions are not nodes in v1; calls inside
them are attributed to the nearest named enclosing function.

## 4. Plugin output types (in `schema`, used by `plugin-api`)

```ts
export interface FileExtraction {
  file: string;                    // repo-relative POSIX path
  language: LanguageId;
  definitions: Definition[];       // become symbol nodes
  imports: RawImport[];            // unresolved import statements
  references: RawReference[];      // unresolved calls / type refs / inheritance
  parseErrors: number;             // count of error nodes; file still used
  meta?: Record<string, unknown>;  // e.g. { "py.packageRoot": "src" }
}

export interface Definition {
  localId: string;                 // qualifiedInFile, e.g. "User.save"
  kind: "class" | "interface" | "function" | "method";
  name: string;
  parentLocalId?: string;          // "User" for "User.save"
  span: { startLine: number; endLine: number };
  signature?: string;
  meta?: NodeMeta;
}

export interface RawImport {
  line: number;
  specifier: string;               // as written: "./utils", "app.models", "github.com/x/y", "java.util.List"
  kind: "module" | "named" | "wildcard" | "side-effect" | "dynamic";
  names?: { name: string; alias?: string }[];
  alias?: string;                  // module alias
  isRelative?: boolean;
}

export interface RawReference {
  line: number;
  kind: "call" | "extends" | "implements" | "type" | "instantiate";
  fromLocalId?: string;            // enclosing definition; absent = module/top level
  name: string;                    // the called/referenced identifier: "save"
  receiver?: string;               // text of receiver expression if any: "self", "this", "user", "np", "pkg.sub"
  receiverKind?: "self" | "super" | "identifier" | "member-chain" | "call" | "other";
  argCount?: number;
}

export interface ResolutionResult {
  imports: GraphEdge[];            // file → file/module/external
  edges: GraphEdge[];              // calls/extends/implements/references
  externals: GraphNode[];          // external nodes to create
  modules?: GraphNode[];           // module nodes (Go packages, Java packages, ...)
  unresolved: { file: string; line: number; name: string; kind: string }[];
}
```

## 5. Analysis result and stats

```ts
export interface AnalysisStats {
  schemaVersion: number;
  analyzerVersion: string;
  commitSha: string;
  languages: Partial<Record<LanguageId, { files: number; bytes: number; pluginTier: 1 | 2 | 3 }>>;
  nodesByKind: Partial<Record<NodeKind, number>>;
  edgesByKind: Partial<Record<EdgeKind, number>>;
  edgesByConfidence: Record<Confidence, number>;
  references: { total: number; resolved: number; unresolved: number };  // resolution rate
  skippedFiles: { reason: string; count: number }[];
  parseErrorFiles: number;
  droppedInvalidEdges: number;
  pluginErrors: { plugin: string; stage: string; message: string }[];  // a plugin failing never fails the analysis
  truncated?: boolean;                 // node/edge cap hit
  timingsMs: Record<string, number>;   // per pipeline phase
}
```

`references` counts only `calls` (see DECISIONS D17): `resolved` = surviving calls edges,
`unresolved` = unresolved entries of kind `call`. Skipped-file reasons are short ids
(`binary`, `lockfile`, `generated-path`, `minified`, `too-large`, `extract-error`, ...).

## 6. Rollups (aggregated views)

For zoomed-out views the core computes:
- `level: "dir"` — for each pair of directories (at every depth), sum of file-level
  `imports` and symbol-level `calls` between their descendants (excluding internal).
- `level: "file"` — file→file weights from imports + calls.

Directory pairs where one directory contains the other are excluded (the root never
appears). `calls` weights sum `meta.callCount`; `imports` count one per edge.

Each row is emitted once per variant: `includeTests` (true/false; false skips edges that
touch a test file) x `minConfidence` (only edges at or above it). The default variant (all
edges) has neither field; the other rows set both (`RollupRow.includeTests`,
`RollupRow.minConfidence`). Stored in the `rollups` table; served by
`GET /graph?level=...`, which picks the variant matching `includeTests` / `minConfidence`.
