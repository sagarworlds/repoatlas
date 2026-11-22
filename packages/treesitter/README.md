# @repoatlas/treesitter

Generic Tier-1 extraction engine (docs/LANGUAGE_PLUGINS.md section 4). A language
supplies a `TreeSitterLanguageSpec` (grammar wasm, three `.scm` queries, scope rules); the
engine turns a file into a schema `FileExtraction`. No language-specific code lives here.

```ts
const ex = await extractWithSpec(spec, { path: "app/models.py", content }, { timeoutMs: 5000 });
```

## Runtime and grammars

- `initTreeSitter()` initialises web-tree-sitter once (concurrent calls share one promise).
  It locates `web-tree-sitter.wasm` with `createRequire(import.meta.url).resolve(
  "web-tree-sitter/web-tree-sitter.wasm")` and passes it via `Parser.init({ locateFile })`
  as a plain absolute path (works on Windows; no file URLs). **Bundled server (esbuild):**
  copy `web-tree-sitter.wasm` next to the bundle and set `TREE_SITTER_WASM_DIR` to that
  directory.
- `loadGrammar(absoluteWasmPath)` caches per path; errors are `GrammarLoadError`.
  Grammar wasm files come from each grammar's own npm package (not `tree-sitter-wasms`).
- `verifyGrammars(paths)` returns `{ wasmPath, ok, abiVersion?, error? }[]` for use in a
  language package's "all grammars load" test.

## Capture conventions

Capture names are written without `@` below. All queries run with `query.matches()`, so
captures of one pattern match stay together.

### definitions

| capture | meaning |
|---|---|
| `definition.class` / `.interface` / `.function` / `.method` | the whole definition node (its span becomes the definition span) |
| `name` | the identifier node holding the name |

Nesting is by node containment. `localId` = parent's id + `.` + name. A `function` whose
nearest enclosing definition has a node type in `scopes.containerTypes` becomes a `method`;
nested functions keep dotted ids (`outer.inner`). Colliding ids get `@startLine`
(`disambiguateLocalIds`). Decorators are outside a `function_definition` node, so spans
start at the `def` line.

### imports

| capture | meaning |
|---|---|
| `import` | whole statement; its first line is `RawImport.line` |
| `import.module` | module specifier node. One `RawImport` per distinct module node (`import a, b` gives two) |
| `import.name` | an imported name; names of the same statement + module are merged (`kind: "named"`) |
| `import.alias` | alias; pairs with the nearest preceding `import.name` in the same match, otherwise it is the module alias (`import a.b as c`) |
| `import.wildcard` | marker, `kind: "wildcard"` |
| `import.side-effect` / `import.dynamic` | markers, `kind: "side-effect"` / `"dynamic"` |
| `import.relative` | marker, forces `isRelative: true` (otherwise: specifier starts with `.`) |

A query may match once per imported name; the engine regroups them. Quoted specifiers
are unquoted; whitespace inside dotted names is removed. Python forms:
`import a.b` -> module; `import a.b as c` -> module + alias; `from a.b import x, y as z`
-> named (`import.module` is the `dotted_name`, one pattern for `name: (dotted_name)`, one
for `name: (aliased_import name: ... alias: ...)`); `from . import x` / `from ..pkg import y`
-> `import.module` is the `relative_import` node (text `.` / `..pkg`); `from a import *`
-> `import.module` + `import.wildcard`. See `src/test-spec.ts` for working queries. For
anything else, use `postProcess`.

### references

| capture | meaning |
|---|---|
| `reference.call` / `.extends` / `.implements` / `.type` / `.instantiate` | whole reference node; the suffix is `RawReference.kind` |
| `name` | referenced name (required) |
| `receiver` | optional object part (`x` in `x.save()`); gives `receiver` and `receiverKind` |
| `args` | optional argument-list node; `argCount` = its named, non-comment children |

`receiverKind` comes from `classifyReceiver(text, nodeType, scopes)`: `self`/`super` from
`scopes.selfNames`/`superNames` (also `super()` calls), `identifier`, `member-chain`
(`a.b.c`), `call`, else `other`. `line` is the `name` node's line. `fromLocalId` is the
innermost enclosing definition by node span (lambdas and comprehensions are not definitions,
so they attribute to the enclosing function; module level has none). Optional
`spec.inferReceiverType(ctx)` fills `receiverTypeHint`.

## Behaviour guarantees

- Never throws for bad syntax. `parseErrors` = count of ERROR + MISSING nodes.
- Per-file budget (`timeoutMs`, default 10 s) covers parse and queries. On expiry the result
  is empty with `parseErrors: 1`, `meta: { timedOut: true }`. A parser exception gives
  `meta: { parseFailed: true, error }`.
- Throws only for configuration bugs: `GrammarLoadError`, `TreeSitterInitError`, `QuerySpecError`.
- Trees and cursors are always deleted. One `Parser` and compiled queries are cached per
  spec object (`releaseSpec(spec)` frees them).
- Output order: definitions in document order (parents first); imports by position;
  references by line, column, name.

## Pure helpers (no WASM, unit-tested)

`toSpan`, `spanContains`, `buildLineIndex`, `positionAt`, `collapseWhitespace`,
`truncateSignature`, `stripQuotes`, `classifyReceiver`, `findEnclosingRanges`,
`comparePositions`, `buildDefinitions`, `buildImports`, `collectReferences`.
