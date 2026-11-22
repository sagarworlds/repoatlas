# Language Plugins

## 1. Support matrix (keep updated)

| Language | Package | Tier | Status | Fixture | Notes |
|---|---|---|---|---|---|
| TypeScript | lang-typescript | 3 (TS compiler API) | implemented (M1) | fixtures/typescript | `allowJs` off until M4; workspace packages resolved through injected `paths`; TS 6 pinned (DECISIONS D6) |
| JavaScript | lang-typescript | 3 (`allowJs`) | planned (M4) | fixtures/javascript | CommonJS + ESM |
| Python | lang-python | 1 (tree-sitter) | implemented (M3) | fixtures/python, fixtures/polyglot | `.py` only (`.pyi` stubs skipped); src-layout roots from `pyproject.toml`/`setup.cfg`; stdlib grouped as `ext:pypi:stdlib`; see section 6 and DECISIONS D30-D36 |
| Go | lang-go | 1 | planned (M4) | fixtures/go | |
| Java | lang-java | 1 | planned (M4) | fixtures/java | |
| C# | lang-csharp | 1 | planned (M5) | fixtures/csharp | |
| Rust | lang-rust | 1 | planned (M5) | fixtures/rust | |
| PHP | lang-php | 1 | planned (M5) | fixtures/php | |
| Ruby | lang-ruby | 1 | planned (M5) | fixtures/ruby | |
| Kotlin | lang-kotlin | 1 | later | | |
| C / C++ | lang-cpp | 1 | planned (M7) | fixtures/cpp | hardest |

Tiers:
- **Tier 1** — tree-sitter syntax + our own scope/import resolution. Fast, no toolchain.
  Edges are mostly `inferred`, some `name-match`.
- **Tier 2** — SCIP indexer output (precise references). Optional, sandboxed, later (M6).
- **Tier 3** — native compiler/type-checker API in-process. Edges mostly `exact`.

## 2. Plugin interface (`packages/plugin-api`)

```ts
export interface LanguagePlugin {
  id: string;                         // "python"
  version: string;                    // bump when output changes
  languages: LanguageId[];            // languages this plugin handles
  tier: 1 | 2 | 3;

  /** Claim files. Called once with all candidate paths. Return the ones this plugin handles. */
  detect(files: RepoFile[]): RepoFile[];

  /**
   * Optional project-level setup before extraction: read manifests (pyproject.toml,
   * go.mod, composer.json, Cargo.toml, tsconfig.json...) and compute package roots,
   * module paths, autoload maps. Must only READ files.
   */
  prepare?(ctx: ProjectContext): Promise<PluginProjectInfo>;

  /** Pure, per-file. Must not throw on bad syntax; count parse errors instead. */
  extract(file: SourceFile, info: PluginProjectInfo): Promise<FileExtraction>;

  /** Needs the whole-repo index. Turns raw imports/references into edges. */
  resolve(input: {
    extractions: FileExtraction[];    // only this plugin's files
    index: SymbolIndex;               // global, all languages
    info: PluginProjectInfo;
    repo: RepoView;                   // file existence checks, read manifests
  }): Promise<ResolutionResult>;

  /**
   * Optional: whole-project mode (Tier 3) doing extract+resolve together. When present it
   * is authoritative; if it throws, core falls back to `extract` per file (no edges).
   * `info` is what `prepare` returned.
   */
  analyzeProject?(ctx: ProjectContext, info: PluginProjectInfo): Promise<{ extractions: FileExtraction[]; resolution: ResolutionResult }>;
}

export interface RepoFile { path: string; bytes: number; }        // POSIX, repo-relative
export interface SourceFile extends RepoFile { content: string; language: LanguageId; }
export interface RepoView {
  exists(path: string): boolean;
  isDir(path: string): boolean;
  read(path: string): Promise<string | undefined>;
  readSync(path: string): string | undefined;   // for synchronous hosts such as the TS compiler
  list(dir: string): string[];
}
```

`createDirRepoView(rootDir)` (in `plugin-api`) builds a `RepoView` over a directory.
Plugins are registered in `packages/core/src/plugins/registry.ts` (default set:
`createDefaultRegistry()`). A plugin that
throws during `resolve` must not kill the analysis: the core catches, logs, records
`pluginErrors` in stats, and keeps that plugin's definitions (without edges).

## 3. The SymbolIndex (built by core)

```ts
export interface SymbolIndex {
  byId: Map<string, GraphNode>;
  byFile: Map<string, GraphNode[]>;                     // symbols defined in file
  byQualifiedName: Map<string, GraphNode[]>;            // "app.models.User.save"
  byShortName: Map<string, GraphNode[]>;                // "save" → all saves (per language!)
  membersOf(classId: string): GraphNode[];              // methods/fields of a class
  superTypesOf(classId: string): string[];              // filled after extends/implements pass
  moduleToFiles: Map<string, string[]>;                 // language-specific module key → files
}
```

`byShortName` lookups must always be filtered by language.

## 4. Tier 1 engine (`packages/treesitter`)

- Use **`web-tree-sitter`** (WASM) — no native compilation, works on Windows/Linux/macOS.
- Grammar `.wasm` files come from each grammar's own npm package (for Python,
  `tree-sitter-python/tree-sitter-python.wasm`), pinned together with `web-tree-sitter`
  (0.27.2). The old `tree-sitter-wasms` bundle does not load with it (DECISIONS D30).
  `verifyGrammars()` loads a list of grammars and reports ABI problems. API in use:
  `Parser.init()`, `Language.load(path)`, `new Query(lang, src)`, `query.matches(node)`.
  Paths are resolved with `createRequire` (or `GRAMMAR_DIR` / `TREE_SITTER_WASM_DIR` in
  a bundle).
- Each Tier 1 language provides a **spec**:

```ts
export interface TreeSitterLanguageSpec {
  language: LanguageId;
  grammarWasm: string | (() => string); // absolute path, resolved lazily at runtime
  extensions: string[];
  queries: {
    definitions: string;               // captures: @definition.class/.interface/.function/.method, @name, @body
    imports: string;                   // captures: @import, @import.module, @import.name, @import.alias
    references: string;                // captures: @reference.call, @name, @receiver, @reference.extends, @reference.implements, @reference.type
  };
  /** How nesting maps to qualified names and whether a function is a method. */
  scopes: {
    containerTypes: string[];          // node types that open a named scope: ["class_definition"]
    selfNames: string[];               // ["self", "cls"] | ["this"] | ["$this"]
    superNames: string[];              // ["super"]
  };
  signature(node: SyntaxNode, src: string): string | undefined;
  /** Type name the receiver of `x.m()` obviously has (fills `RawReference.receiverTypeHint`). */
  inferReceiverType?(ctx: ReceiverTypeContext): string | undefined;
  /** Language-specific fix-ups (e.g. Go receiver methods, Rust impl blocks). */
  postProcess?(ex: FileExtraction, tree: Tree, src: string): FileExtraction;
}
```

- Store queries as `.scm` files next to the spec (`packages/lang-python/queries/*.scm`).
  The grammar repos' own `queries/tags.scm` are a good starting point — adapt them, keep
  attribution/licence notes in a `queries/README.md`.
- Queries run with `query.matches()` so the captures of one pattern stay grouped. Capture
  conventions (full list in `packages/treesitter/README.md`):
  - definitions: `@definition.class|interface|function|method` on the whole node, `@name`
    on the identifier. A function directly inside a `containerTypes` node is a method.
    Duplicate ids become `f@<startLine>`. `@body` is not used.
  - imports: `@import` (whole statement), `@import.module`, `@import.name` (repeats are
    merged into one `named` import), `@import.alias`, `@import.wildcard`.
  - references: `@reference.call|extends|implements|type|instantiate` on the whole node,
    `@name`, optional `@receiver` and `@args` (gives `argCount`).
- Each file has a parse deadline (`DEFAULT_PARSE_TIMEOUT_MS`, 10 s) covering parse, queries,
  receiver inference and `postProcess`; on expiry the file is reported as a parse error.
  Trees and queries are freed after use.
- The generic engine: parse → run definition query → build definition tree from
  capture nesting → run import query → run reference query → attach each reference to
  its innermost enclosing definition (`fromLocalId`) by span containment.

## 5. Generic resolution algorithm (Tier 1)

Each plugin implements resolution, but most follow this order. Stop at the first hit.

For each `RawReference` of kind `call`:

1. **Receiver is self/this** (`receiverKind: "self"`): look up `name` in the enclosing
   class's members, then walk `superTypesOf` (method resolution order for Python:
   left-to-right depth-first is acceptable in v1). → `inferred`
   (`exact` if found directly in the same class and the language has no monkeypatching
   concerns — keep it `inferred` for Python/Ruby/PHP/JS).
2. **Receiver is super**: look up in super types only. → `inferred`
3. **No receiver**: local function in same file scope → imported name (via this
   file's resolved imports map `localName → target node`) → same module/package
   (Go: same directory; Java: same package; C#: same namespace) → `inferred`.
4. **Receiver is an identifier bound by an import** (`np.array`, `utils.helper`,
   `pkg.Func`): resolve the import target, then find `name` inside it. → `inferred`;
   if the import target is external → edge to the `external` node is **not** created
   for every call; instead one `imports` edge exists at file level (avoid noise).
5. **Receiver is an identifier that is a known class name** (static call
   `User.create()`): find member. → `inferred`
6. **Receiver is a local variable whose type is obvious** from a same-function
   assignment `x = User(...)` / `x := NewUser()` / `var x = new User()` /
   type annotation `x: User`: find member. → `inferred`. (Simple, same-function only.)
7. **Fallback name-match**: candidates = `byShortName(name)` in the same language,
   preferring methods if a receiver exists, functions otherwise; exclude very common
   names (see §5.1). If 1–3 candidates → `name-match` edges. Else → unresolved.

`extends` / `implements`: resolve the type name like case 3 (imports → same module →
name-match). Resolve all inheritance **before** calls, since step 1 needs super types.

### 5.1 Name-match stoplist
Do not name-match these (too ambiguous, mostly builtins/collections): `get`, `set`,
`add`, `remove`, `push`, `pop`, `append`, `map`, `filter`, `reduce`, `forEach`, `len`,
`print`, `log`, `toString`, `equals`, `hashCode`, `init`, `__init__`, `run`, `call`,
`apply`, `then`, `catch`, `write`, `read`, `close`, `open`, `update`, `delete`, `new`.
Keep the list in `plugin-api` and allow per-language additions.

### 5.2 Import resolution output
Every resolved import produces an `imports` edge `file → file` (internal),
`file → module` (where a module node exists), or `file → external`.
Plugins also produce, per file, a **binding map** `localName → nodeId` used by steps 3–4.

## 6. Per-language rules

### TypeScript / JavaScript (Tier 3, `lang-typescript`)
- Build one `ts.Program` with all `.ts/.tsx/.mts/.cts` (+ `.js/.jsx/.mjs/.cjs` with
  `allowJs`) files. Read the root `tsconfig.json` with `ts.parseJsonConfigFileContent`
  but override: `noEmit: true`, `skipLibCheck: true`, `allowJs: false` (M1; becomes
  `true` in M4), `types: []`, drop `plugins`, `typeRoots`, `outDir`, `rootDir`. If no
  tsconfig, use sane defaults. Respect `paths`/`baseUrl` (`paths` stay relative to the
  config file that declared them).
- `node_modules` does not exist (we never install), so bare imports resolve to nothing →
  emit `ext:npm:{package}` (strip subpaths: `lodash/fp` → `lodash`; keep scope `@a/b`).
- Monorepos: if `pnpm-workspace.yaml` / `package.json#workspaces` exist, map workspace
  package names to their directories so `@acme/utils` resolves internally. This is done
  by injecting `paths` entries into the compiler options (so calls, `extends` and type
  references across packages are resolved by the TypeChecker, not only `imports` edges);
  `resolveWorkspaceImport` is the fallback for import edges.
- Node built-ins collapse into `ext:node:builtins` (DECISIONS D10).
- Calls whose callee is typed `any` (unresolvable externals) produce no edge and are not
  counted as unresolved. Calls through interface-typed receivers, mixins, decorators and
  tagged templates produce no edges (known gaps).
- Robustness: AST walkers are iterative (no stack overflow on deep expressions) and each
  file's work is isolated with try/catch; one bad file is recorded and skipped.
- Use the TypeChecker: `getSymbolAtLocation(callExpr.expression)`, follow
  `getAliasedSymbol` for imports, map the declaration back to our node ID. → `exact`.
- Never call `getPreEmitDiagnostics` (slow, unnecessary). Large repos: if > 5,000 TS
  files, split by tsconfig project references or directory chunks.
- Definitions: classes, interfaces, functions, methods, and `const x = () => {}` /
  `const x = function` as `function` nodes. Object-literal methods: skip in v1.

### Python (`lang-python`)
- Package roots: repo root, `src/`, and any dir listed in `pyproject.toml`
  (`[tool.setuptools.packages.find] where`, `[tool.poetry] packages`). A file's module
  name = path from its package root, dots, without `.py`; `__init__.py` = the package.
- Imports: `import a.b`, `import a.b as c`, `from a.b import x, y as z`,
  `from . import x`, `from ..pkg import y` (resolve relative to current package),
  `from a import *` (wildcard: bind all top-level names of target, `inferred`).
- `from pkg import name` where `name` is a submodule → file import; where it is a
  symbol re-exported in `pkg/__init__.py` → follow one level of re-export.
- Externals: any top-level module not found internally → `ext:pypi:{top-level}`.
  (Map well-known import→dist names later, e.g. `yaml`→`PyYAML`; not required.)
- Methods: functions directly inside `class_definition`. `self.x()`/`cls.x()` → self.
  Decorators → `meta["py.decorators"]`. `@staticmethod`/`@classmethod` → `isStatic`.
- `Foo()` where `Foo` resolves to a class → call to `Foo.__init__` if defined, else reference.
- Test files: `test_*.py`, `*_test.py`, `conftest.py`, `tests/` or `test/` → `isTest`.
- Implementation notes (M3, see DECISIONS D31-D36):
  - Relative imports keep their dots in the specifier (`.`, `..pkg`). `from . import x` in a
    root-level module looks `x` up among the root modules; climbing to or past the top
    package is unresolved, never an external. Calls are always kind `call`; calling a
    class goes to `__init__` (own or inherited), else a `references` edge.
  - stdlib imports collapse into one `ext:pypi:stdlib` node (meta `package(s)`). Python
    modules are bound by `file:` id (no `mod:` nodes). A stdlib-named directory without
    `__init__.py` does not shadow the stdlib.
  - Function-level imports bind for that function (overlay on the file-wide map; a
    module-level import of the same name wins elsewhere). Try/except imports are file-wide.
  - Receiver hints (`receiverTypeHint`): same-scope `x = Foo()`, annotations, parameters,
    `Foo().m()`, `self.x = Foo()` attributes, pytest fixtures; every binding must agree.
    Meta keys: `py.decorators`, `py.staticmethod|classmethod|property`, `py.params`,
    `py.returns`.
  - A call through a parameter makes no edge. A missed `super().m()` is unresolved (never
    name-matched). Names that are builtins or builtin-type methods are not reported as
    unresolved.
  - Only one level of re-export is followed; `__all__` is read only as a literal list.

### Go (`lang-go`)
- Read `go.mod` for the module path (multiple `go.mod` → multiple modules).
  Import path `{module}/{dir}` → all `.go` files in that dir (one `module` node per package).
- Package = directory; all files in a package share scope → unqualified calls resolve
  across files in the same directory.
- Methods: `func (s *Server) Start()` → method `Server.Start` attached to type `Server`
  (which may be declared in another file of the package; parent resolution happens in
  `resolve`). Use `postProcess` to set `parentLocalId` from the receiver type.
- Interfaces are satisfied implicitly → do **not** emit `implements` in Tier 1.
- Standard library imports (no dot in first path element, e.g. `fmt`, `net/http`) →
  a single `ext:go:stdlib` node (put the package path in the edge's `meta.package`) to
  avoid hundreds of nodes. Third-party → `ext:go:{module path}` (first 3 segments for github.com).
- `_test.go` → `isTest`.

### Java (`lang-java`)
- Package from `package` declaration; class FQN = `package.Class`. Index by FQN.
- Imports: single-type (`import a.b.C`), wildcard (`import a.b.*`), static imports.
  Same-package classes visible without import.
- Nested/inner classes: `Outer.Inner`. Constructors → method named after the class
  (`User.User`) for readability, with `meta.isConstructor = true`.
- `extends` / `implements` straightforward from syntax.
- Overloads: same name, disambiguated by `@line` (see schema §3); calls to overloaded
  names use argument count to pick; if still ambiguous → edges to all, `name-match`.
- External: packages not found in repo → `ext:maven:{first two or three segments}`
  (e.g. `org.springframework`). `java.*`/`javax.*` → `ext:maven:jdk`.

### C# (`lang-csharp`)
- **Namespaces are not tied to files.** Build namespace → types map across the repo
  (block and file-scoped `namespace X;`). `using X.Y;` brings all types in that
  namespace into scope; `using A = X.Y.Z;` aliases.
- `partial` classes: one class node per declaration, `meta.partial = true`. The
  resolver treats all partial parts with the same FQN as one member set (no extra edges
  between the parts).
- Read `.csproj` `<PackageReference Include="...">` for externals (`ext:nuget:{id}`);
  `System.*` / `Microsoft.*` without matching repo types → `ext:nuget:dotnet`.
- Properties with bodies (`get`/`set`) → skip in v1; methods, constructors, local
  functions (skip local functions in v1).

### Rust (`lang-rust`)
- Crate roots from `Cargo.toml` (`src/lib.rs`, `src/main.rs`, `[[bin]]`, workspace
  members). Build the module tree: `mod foo;` → `foo.rs` or `foo/mod.rs` next to the
  declaring file; inline `mod foo { ... }`.
- `use crate::a::b::C`, `use super::x`, `use self::y`, groups `use a::{b, c as d}`,
  globs `use a::*`.
- `impl Type { fn m() }` → method `Type.m`; `impl Trait for Type` → methods on `Type`
  plus `implements` edge `Type → Trait`. Traits → `interface` kind.
- Externals: crates in `[dependencies]` → `ext:crates:{name}`; `std`/`core`/`alloc` → `ext:crates:std`.
- Macros (`foo!()`) are not calls in v1.

### PHP (`lang-php`)
- `composer.json` `autoload.psr-4` (and `autoload-dev`) maps namespace prefixes →
  dirs. Class FQN `App\Models\User` → file via PSR-4.
- `use App\Models\User;`, `use ... as Alias;`, grouped `use App\{A, B};`.
- `$this->m()` → self; `self::m()` / `static::m()` → self static; `parent::m()` → super;
  `User::create()` → static call on class.
- Externals: `require` packages → `ext:composer:{vendor/package}`.

### Ruby (`lang-ruby`)
- Classes can be reopened across files: one class node per declaration; resolver
  treats all with the same constant path as one member set (like C# partials).
- `require_relative` resolves relative to the file; `require 'x'` → search `lib/`
  then external `ext:rubygems:{x}` (top segment).
- Rails heuristic (if `config/application.rb` exists): Zeitwerk naming — constant
  `Admin::UsersController` ↔ `app/controllers/admin/users_controller.rb`; resolve
  constants without explicit requires. → `inferred`.
- tree-sitter-ruby distinguishes `call` nodes from bare `identifier`s; a bare identifier
  could be a local variable or a no-paren method call. Treat it as a call only if no
  local assignment with that name precedes it in the method.
- `include`/`extend` of a module → `implements`-like: emit `extends` with
  `meta.mixin = true`.

### C / C++ (`lang-cpp`, last)
- `#include "x.h"` resolves relative to the file, then to include dirs guessed from
  `CMakeLists.txt` (`include_directories`, `target_include_directories`) and common
  dirs (`include/`, `src/`). `<x>` → external `ext:system:{x}` grouped.
- Link declarations in headers to definitions in `.c/.cpp` (`void Foo::bar()` →
  `Foo.bar`): one node, span = definition, `meta.declaredIn = header path`.
- Namespaces → qualified names. Templates, macros, overloads → expect many
  `name-match` edges; that is acceptable.
- If a `compile_commands.json` is committed, use its include paths (read only).

## 7. Adding a new language — checklist

1. Create `packages/lang-<id>` with spec, queries, resolver, `index.ts` exporting the plugin.
2. Add the grammar wasm and a "grammar loads" test.
3. Create `fixtures/<id>/` (see `docs/TESTING.md`) and `expected-edges.json`.
4. Implement `prepare` (manifests), `extract` (via engine), `resolve`.
5. Register in `core/src/plugins/registry.ts`.
6. Run on 2–3 real repos via `pnpm analyze`; inspect stats (resolution rate, edge
   confidence mix). Record findings in `docs/DECISIONS.md`.
7. Update the support matrix above.
