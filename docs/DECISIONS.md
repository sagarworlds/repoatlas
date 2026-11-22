# Decisions (ADR-lite)

Append new entries at the bottom. Format:

```
## D<n> — <title> (<YYYY-MM-DD>)
**Context:** why a decision was needed
**Decision:** what we chose
**Alternatives:** what we rejected and why
**Consequences:** follow-ups, risks
```

---

## D1 — TypeScript/Node for the whole stack
**Context:** The TypeScript plugin uses the TS compiler API, which only runs in
JavaScript. The frontend is TypeScript regardless of backend choice.
**Decision:** Node.js + TypeScript for backend, plugins, CLI and frontend, in one pnpm
monorepo: one language, one runtime, schema types shared directly with the UI.
**Alternatives considered:**
- C# / .NET — maintainer's strongest language, best raw performance, Roslyn gives exact
  analysis of C# repos, native IIS hosting. Rejected because it needs a second runtime
  (Node sidecar for the TS plugin), a second language (TS frontend), and .NET tree-sitter
  bindings are less mature.
- Python — mature tree-sitter bindings, best ecosystem for later GraphRAG work. Rejected
  for the same two-language/two-runtime reason, plus slower parsing.
- Rust — fastest, tree-sitter's native home. Rejected: steep learning curve and slow
  iteration; same Node sidecar requirement.
**Consequences:** Heavy parsing moves to worker threads (M4). The maintainer is learning
TypeScript (see CLAUDE.md "Working with the maintainer"). If parsing speed ever becomes
the bottleneck, the parsing engine can be rewritten in Rust as an isolated component.
GraphRAG/ML work may later add a small Python service if APIs from Node are not enough.

## D2 — web-tree-sitter (WASM) instead of native node-tree-sitter
**Context:** Must run on Linux, macOS and Windows without native build toolchains.
**Decision:** `web-tree-sitter` with prebuilt grammar `.wasm` files, pinned versions.
**Alternatives:** `tree-sitter` native bindings (faster, but native compilation and
ABI issues across platforms).
**Consequences:** Somewhat slower parsing; grammar/runtime version pinning required.

## D3 — Tarball download, not git clone
**Context:** Safety and speed for untrusted public repos.
**Decision:** GitHub REST tarball endpoint + safe streaming extraction.
**Consequences:** No submodules or LFS content (acceptable).

## D4 — SQLite for MVP storage
**Context:** Single-node deployment, zero infra.
**Decision:** `better-sqlite3`, WAL mode, behind a `GraphStore` interface.
**Alternatives:** Postgres (later, for multi-instance), Neo4j/graph DB (later, for GraphRAG).

## D5 — Cytoscape.js for graph rendering
**Context:** Need compound nodes (directories containing files), several layouts, good
interaction APIs.
**Decision:** Cytoscape.js + fcose (map) + dagre (call flow).
**Alternatives:** Sigma.js/graphology (WebGL, scales to larger graphs, no compound
nodes), React Flow (great for small DAGs, weak for large force layouts).
**Consequences:** Keep rendered graphs ≤ 2,000 nodes via level-of-detail; revisit
Sigma.js if that becomes limiting.

## D6 — TypeScript 6 is pinned inside `lang-typescript`
**Context:** The workspace root uses TypeScript 7 (native compiler) for `tsc --noEmit`, but
TS 7 has no JavaScript compiler API. The TypeScript plugin needs `ts.createProgram` and the
TypeChecker.
**Decision:** `packages/lang-typescript` depends on `typescript@6.0.3` (exact JS API); every
other package type-checks with the root TS 7.
**Consequences:** Two TypeScript versions in `node_modules`. Revisit when the TS 7 JS API
(or a stable programmatic API) ships.

## D7 — Stay on `better-sqlite3`, not `node:sqlite`
**Context:** Node ships an experimental built-in `node:sqlite`.
**Decision:** Keep `better-sqlite3` (D4). Its bundled SQLite has FTS5 with the trigram
tokenizer (verified, SQLite 3.54), WAL, and a stable synchronous API with prepared
statements and transactions.
**Alternatives:** `node:sqlite` (no native build, but still experimental and FTS5/trigram
availability depends on the Node build).
**Consequences:** A native module that needs a prebuilt binary or toolchain on install.
Every query is synchronous and blocks the event loop, so request work must stay bounded
(see D20).

## D8 — Tier 3 plugins run whole-project via `analyzeProject(ctx, info)`
**Context:** The TypeScript plugin needs one `ts.Program` for all files; the per-file
`extract` + `resolve` split of `LANGUAGE_PLUGINS.md` does not fit.
**Decision:** `LanguagePlugin.analyzeProject(ctx, info)` is optional and authoritative: when
present, core takes definitions, imports and edges from it. `info` is the value returned by
`prepare`. If `analyzeProject` throws, core falls back to per-file `extract` with an empty
resolution and records a `pluginErrors` entry (stage `analyze`). `RepoView` gained a
synchronous `readSync` (the TS compiler host is synchronous) and plugin-api ships
`createDirRepoView(rootDir)`.
**Consequences:** Plugins read the repository only through `RepoView`; the TS host never
touches `ts.sys`. TS `extract()` is syntax-only and exists for the fallback path.

## D9 — Structure nodes only for claimed source files
**Context:** Which files and directories become graph nodes.
**Decision:** `file` and `directory` nodes are created only for files a plugin claimed and
that extracted successfully, plus any non-source file an edge points at (for example an
imported `.json` or `.d.ts`). Directories exist only when a claimed file is below them. The
root directory node is `dir:` named after the repo. A directory whose files are all tests
gets `meta.isTest = true` so `includeTests=false` prunes it. Files that failed extraction
are skipped (`extract-error`, `invalid-extraction`) and get no nodes.
**Consequences:** READMEs, images and unsupported languages never appear in the map.

## D10 — Node built-ins are one external: `ext:node:builtins`
**Context:** `fs`, `path`, `node:crypto`... would add dozens of external nodes of no
interest.
**Decision:** All Node built-ins collapse into one external node `ext:node:builtins`
(`ecosystem: "node"`), one `imports` edge per file, with `meta.package` (first specifier)
and `meta.packages` (all of them).
**Consequences:** UI shows one "node builtins" box. Other ecosystems keep one node per
package.

## D11 — Rollups come in variants and use an exclusion rule
**Context:** `GET /graph?level=dir|file` reads pre-aggregated rollups, but `includeTests`
and `minConfidence` must still work there.
**Decision:** A directory pair `(A, B)` is counted only when neither contains the other (so
the root and ancestor/descendant pairs never appear). Each `(level, src, dst, kind)` is
stored once per variant: includeTests (true/false) x minConfidence (exact/inferred/
name-match). The default variant has no variant fields; the others carry `includeTests` and
`minConfidence` (columns `include_tests`, `min_confidence`, migration 002). Aggregated edges
are returned with confidence `inferred` (or `exact` when `minConfidence=exact`, since then
every counted edge is exact).
**Consequences:** Up to 6x more rollup rows, no query-time edge scans.

## D12 — Source storage layout and retention
**Decision:** `DATA_DIR/repoatlas.db` (SQLite), `DATA_DIR/sources/{commitSha}/` (extracted
files, shared by every analysis of that commit), `DATA_DIR/tmp/{analysisId}/` (per-job
download dir, always removed, wiped on boot), `DATA_DIR/recovery.json` (see D13). A fetch
extracts into `tmp/` and renames atomically to `sources/{sha}`; if another job won the
race its directory is used. A second analysis of the same SHA reuses it without
downloading. Eviction keeps the newest `CACHE_MAX_ANALYSES` finished (done or failed)
analyses and deletes `sources/{sha}` when no done or in-flight analysis references it; a
failed analysis does not pin sources, and its sources are removed right after it fails.
**Consequences:** Failed analyses keep a small row (the error message) until evicted.

## D13 — Startup recovery design
**Context:** No attempts column in the store.
**Decision:** Retry counters live in `DATA_DIR/recovery.json` (`{"attempts":{id:n}}`,
atomic writes; missing or corrupt means no retries spent; entries for analyses that are no
longer unfinished are dropped each boot). On boot: wipe and recreate `tmp/`; a `queued` row
is re-queued without spending a retry; a running row (fetching/parsing/resolving/
persisting) with no prior attempt is reset to `queued` and re-queued once; a running row
already retried is marked `failed` (`INTERNAL`, "interrupted by a server restart").
Graceful shutdown aborts running jobs and leaves their rows non-terminal so the next boot
recovers them; a watchdog forces exit after 8 s.

## D14 — HTTP error status mapping
**Decision:** Body is always `{error:{code,message}}`. `INVALID_REPO_URL`/`VALIDATION_ERROR`
400, `REPO_PRIVATE` 403, `*_NOT_FOUND`/`NOT_FOUND` 404, `ANALYSIS_NOT_READY` 409,
`REPO_TOO_LARGE`/`NO_SUPPORTED_LANGUAGES` 422, `RATE_LIMITED` 429, `INTERNAL`/`CANCELLED`
500, `TIMEOUT` 504. `REPO_TOO_LARGE` is 422 and not 413 because 413 means the request body
is too large, not the repository. Internal errors never leak details; they are logged.

## D15 — Search: FTS5 trigram plus bound LIKE
**Decision:** `nodes_fts` is an FTS5 table with the `trigram` tokenizer, keyed by
`nodes.rowid`, filled explicitly (no triggers). Queries of 3+ characters are wrapped as one
quoted FTS5 phrase (operators are inert); 1-2 characters use a bound `LIKE` with escaped
wildcards. Control characters are stripped in the store and rejected (400) by the API.
Rank: exact name > prefix > substring, then degree, then name.

## D16 — `TRUST_PROXY` is a hop count, never a boolean
**Context:** With `trustProxy: true` Fastify takes the leftmost `X-Forwarded-For` entry,
which a client can forge, defeating the per-IP rate limits.
**Decision:** `TRUST_PROXY` accepts `false`/`0` (default), `loopback`, or a hop count
(IIS/ARR: `1`). `true` is rejected at startup. With a hop count only the entry appended by
our own proxy is believed.

## D17 — Reference statistics rule (counting rule superseded by D32)
**Decision:** `resolved` = surviving `calls` edges (counting `callCount`) before merging.
`unresolved` = unresolved entries of kind `call`; unresolved imports are listed in
`PipelineResult.unresolved` but are not in the rate. For plugins with `analyzeProject`
`total = resolved + unresolved`. Calls whose callee is typed `any` (unresolvable external
libraries) are in neither number.
**Consequences:** The TS rate cannot see calls into libraries; see the known gap about
calls through unresolved internal imports in `LANGUAGE_PLUGINS.md`.

## D18 — Workspace packages are fed to the TypeScript compiler
**Context:** Resolving workspace imports only for `imports` edges left cross-package calls
and `extends` typed `any` and silently dropped.
**Decision:** `lang-typescript` injects `paths` entries (`name` to the package entry file,
`name/*` to `src/*` then `*`) into the compiler options, using absolute virtual paths. The
project's own `paths` win. `resolveWorkspaceImport` remains the fallback for import edges.
Also: `pathsBasePath` is kept as TypeScript computed it (the config that declared `paths`).

## D19 — Strict URL parsing and tar extraction
**Decision:** The URL parser rejects `www.github.com`, ports, query strings, fragments (not
stripped), any `%`, `@`, backslash, whitespace or control character, and any `..` in a ref;
`.git` is stripped only directly after the repo name. Redirects are followed manually (max
5) and only to the GitHub API origin or `https://codeload.github.com`; the token is sent
only to the API origin. The tar extractor streams chunk by chunk, counts every
non-directory entry against `MAX_FILES`, guards zip bombs by gunzipped input bytes
(3x `MAX_TARBALL_BYTES`), re-checks received bytes per file, detects case collisions per
path prefix, and skips: `unsafe-path`, `reserved-name`, `path-too-long`, `symlink`,
`hardlink`, `special-file`, `too-large-file`, `case-collision`, `duplicate`,
`path-conflict`.

## D20 — Request work must be bounded (synchronous SQLite)
**Decision:** `getSubgraph` stops collecting nodes at 4x the node cap (breadth first, so
shallow nodes win) and reports `truncated: true`. Callflow and deps walks keep one visited
set per direction (a node reached upward must still be expanded downward) and cap results
at 500 nodes.

## D21 — Pipeline output is sanitized item by item
**Decision:** Core owns the containment tree: plugin-emitted `contains` edges are always
dropped. Every plugin edge, external/module node and unresolved entry is parsed on its own
with zod; invalid edges count in `droppedInvalidEdges`, invalid nodes or entries add one
`pluginErrors` entry (stage `validate`). Node and edge caps (500k / 2M) truncate and set
`stats.truncated`. A failing file is recorded as skipped (`extract-error`) and never fails
the analysis; TS per-file work is isolated with try/catch and uses iterative AST walkers
(deeply nested expressions do not overflow the stack).

## D22 — New dependencies (M1)
`tar` (streaming parser only), `zod`, `better-sqlite3`, `fastify` with `@fastify/helmet`,
`@fastify/cors`, `@fastify/rate-limit`, `@fastify/static` and `fastify-type-provider-zod`,
`p-queue` (job concurrency), `ulid` (analysis ids, `an_` prefix), `typescript@6` (plugin
only, see D6).

## D23 — Source-level workspace packages, no project references (2026-11-20)
**Context:** ROADMAP M0 asked for tsconfig project references.
**Decision:** Workspace packages expose `"exports": {".": "./src/index.ts"}` and each package
has a standalone `tsconfig.json` extending `tsconfig.base.json`; `pnpm typecheck` runs
`tsc --noEmit` per package. Node code runs via `tsx`, tests via Vitest, web via Vite.
**Alternatives:** Composite projects with `tsc -b` (needs a build step in the dev loop).
**Consequences:** No build step in dev. Revisit if typecheck gets slow or if packages must be
published. How production runs the API (tsx or a bundle) is decided in the M2 deploy task.

## D24 — Tooling versions and config choices (2026-11-20)
**Decision:** TypeScript 7 at the repo root (typecheck only; lang-typescript pins 6, see D6),
Vitest 5 (`test.projects` globs), Biome 2 (Markdown excluded: it reformats docs), zod 4,
Fastify 5, Vite 8, React 19. The config loader uses Node's built-in `process.loadEnvFile`
(no dotenv); `.env` is resolved from the module location. `.gitattributes` forces LF so Biome
passes on Windows CI. pnpm needs `allowBuilds` for `esbuild` and `better-sqlite3`.

## D25 — Web stack for M2 (2026-11-21)
**Decision:** Tailwind CSS v4 (`@tailwindcss/vite`, tokens as CSS variables exposed through `@theme inline`,
dark mode by a `dark` class on `<html>` set by an external `public/theme-init.js` so helmet's
`script-src 'self'` still works), React Router 7, TanStack Query 5 (typed hooks in `src/api/hooks.ts`),
Cytoscape with `fcose` (map) and `dagre` (call flow), Shiki 4.
**Consequences:** `apps/web` has no `zod` dependency; responses are checked with small hand-written
guards plus the schema package's own zod schemas for status, progress and stats. Control borders use
`--line-strong` (3:1 contrast), decorative separators use `--line`.

## D26 — URL is the explorer state (2026-11-21)
**Decision:** Tab, selection and filters live in the query string, parsed and serialized in
`explorer/url-state.ts`. Params: `tab` (map|flow|deps), `node`, `file`, `root`, `level`, `kinds`, `conf`,
`tests`, `ext`, `depth` (map 1-5, deps 1-3; defaults omitted), `up`, `down`, `dir`, `hl` (`path@line`
call-site highlight). `setParams` replaces history by default; selections push. `applyPatch` clears `file`
and `hl` whenever `node` changes and the patch does not set them, so a new selection never inherits the
previous deps centre or call-site highlight. Only a tab change resets `depth` to the tab default.

## D27 — Cytoscape is lazy and hidden behind adapters (2026-11-21)
**Decision:** `cy-adapter.ts` (map) and `cy-flow-adapter.ts` (flow) dynamic-import Cytoscape and its layouts,
so the home page loads neither. Graph building, styles and layout options are pure functions tested without a
canvas. Each Cytoscape instance gets its own host div (map) or an inline `position:absolute;inset:0` (flow);
Cytoscape injects an unlayered `position: relative` rule that would beat Tailwind's layered classes. Fresh
layouts are not animated, expansions are. Above 800 nodes fcose runs in draft quality without tiling,
component packing or label-aware sizing; the 2,000-node cap stays, and a main-thread pause is still possible
near it (no virtualized tree, no "laying out" status yet).

## D28 — Shiki without innerHTML (2026-11-21)
**Decision:** `shiki/core` with the JavaScript regex engine (no WASM), github-light/github-dark themes and
per-language lazy chunks. We use `codeToTokens` and render tokens as React spans, so repository text is never
injected as HTML. Requests are capped at 2,000 lines and only the first 3,000 lines are highlighted.

## D29 — Deploy bundle and API bundling (2026-11-21)
**Decision:** `pnpm build` builds the web app, then esbuild bundles `apps/api/src/index.ts` into
`apps/api/dist/server.js` (everything bundled except `better-sqlite3`, native, and `typescript`, which reads its
own lib `.d.ts` files). `scripts/make-deploy-bundle.ts` assembles `app\apps\api\dist`, `app\apps\web\dist`,
`app\node_modules` (those two externals, copied from the workspace install so versions match the lockfile),
`site\web.config` and a README. `pnpm deploy` was rejected: it changes the layout and brings 97 MB of symlinks.
In the dist layout `.env` and a relative `DATA_DIR` resolve against the parent of `app\`. Tree-sitter grammars are
copied since M3 (D34). `scripts/verify-bundle.ts` is a manual dry run that starts the bundle from an
unrelated cwd the way IIS does.


## D30 — Grammar wasm from per-language npm packages, pinned with web-tree-sitter 0.27.2 (2026-11-22)
**Decision:** `web-tree-sitter` 0.27.2 with `tree-sitter-python` 0.25.0 (`tree-sitter-python.wasm` inside the
package). The `tree-sitter-wasms` bundle was rejected: its files fail to load with 0.27.2 (dylink error).
Packages are installed only for their wasm (`allowBuilds: false`, no native build). One `Parser` and compiled
query set per spec is cached in a WeakMap; trees and cursors are always deleted. Parse timeout: the parse
progress callback returns true after a deadline, and the deadline is also checked after each query stage, during
receiver inference and after `postProcess`. Queries use `query.matches()`.
**Consequences:** New languages add their grammar package and a `GRAMMAR_FILES` line (D34). The query-stage cancel
semantics were not verified; the stage checks are the fallback.

## D31 — receiverTypeHint and extraction-time type inference (2026-11-22)
**Decision:** `RawReference.receiverTypeHint` (optional) holds the type name the receiver obviously has. The
engine calls the spec's `inferReceiverType`; resolvers look the hint up like an identifier. Python infers only
when every binding in scope agrees: `x = Foo()`, `x: Foo`, annotated parameters, `Foo().m()`, `self.x = Foo()`
(`None` is neutral), pytest fixtures (return type of the `@fixture` in the same file or a `conftest.py` above).
Bindings are collected once per scope or class in a linear walk (cached per tree); a first version rescanned the
scope per reference and was quadratic (found in review: 64 KB file took 26 s).
**Consequences:** Hints are conservative and not flow-sensitive. Return types of calls and attribute types of
other objects are not followed (`py.returns` is recorded but only used for fixtures).

## D32 — Per-language reference stats and the rate denominator (2026-11-22)
**Decision (supersedes the counting part of D17):** `total = resolved + unresolved` for every plugin tier, split
per language in `stats.languages[lang].references` (optional, so old analyses validate); the top-level number is
the sum. Calls into externals, builtins and builtin-type methods (stoplist), and calls through a parameter, are in
neither number. The CLI checks each language against its own TESTING target, and the web banner uses the same
data. Reason: with all raw calls in the denominator Python could not reach 65% (psf/requests 38.6%,
pallets/click 56.0%) because most calls go to stdlib or builtins.
**Consequences:** Rates are comparable with TypeScript Tier 3. Old stored analyses keep their larger totals.
**Open for the lead:** confirm this definition change before M3 acceptance is ticked.

## D33 — Python plugin conventions (2026-11-22)
**Decision:** Python is Tier 1 (`prepare`/`extract`/`resolve`). Roots: repo root, `src/`, `pyproject.toml` and
`setup.cfg` entries (parsed by a small strict TOML subset parser and a linear INI reader with size and line
caps, never executed), and `__init__.py` chains. Module names come from the path; collisions: package first, then
alphabetical. Imports keep dots in the specifier; stdlib imports become `ext:pypi:stdlib`, others
`ext:pypi:{top}`; Python modules bind by `file:` id. `from pkg import name` tries symbol, submodule, then one
level of re-export (two-pass, so cycles cannot loop). Function-level imports are scoped to the function (overlay),
module-level wins elsewhere. `.pyi` stubs are skipped (they would duplicate the module's symbols). Calls are kind
`call`; a class call goes to `__init__` (own or inherited), else a `references` edge. Same-file definitions beat
imports. A missed `super().m()` is unresolved. Fixture `fixtures/python` was corrected: `Admin(User)` without an
`__init__` calls `User.__init__`.
**Consequences:** See LANGUAGE_PLUGINS section 6. Not covered: `__all__` beyond literals, two-level re-exports,
`setup.py`, flow-sensitive typing.

## D34 — Grammar and query bundling (2026-11-22)
**Decision:** `web-tree-sitter` is bundled by esbuild into `server.js`; its wasm and each grammar wasm are copied to
`app\grammars`, Python query files to `app\queries\python`. A banner at the top of `server.js` sets `GRAMMAR_DIR`,
`TREE_SITTER_WASM_DIR` and `PYTHON_QUERIES_DIR` from the file location when unset (the Python plugin loads its
queries at import time). `applyGrammarDefaults` in `config.ts` does the same for the wasm dirs later.
**Consequences:** No `web.config` variables. `verify-bundle.ts` has 17 checks including a Python parse from an
unrelated cwd.

## D35 — Shared resolver helpers in plugin-api (2026-11-22)
**Decision:** LANGUAGE_PLUGINS section 5 steps are composable pure functions in `plugin-api/src/resolve`
(`resolveReference`, `applySuperTypes`, `toEdges`, ...). A binding to an external ends resolution with reason
`external` (no name-match, to avoid false edges). Top-level symbols have `parentId = file:{path}`, so helpers use
`isTopLevelSymbol`. Name-match results are never recorded as super types.

## D36 — Untrusted-input limits in the Python path (2026-11-22)
**Decision:** Review found three superlinear paths reachable from a hostile repo: receiver inference, annotation
owner lookup in `postProcess` (now a sorted sweep) and the `setup.cfg` key regex (now an `indexOf`-style scan,
200 KB total and 2,000 chars per line). All stages after parsing now respect the per-file deadline. Parsing in a
worker thread (planned for M4) remains the real protection for a runaway grammar.

---

## Real-repo smoke results
| Date | Language | Repo @ sha | Files | Resolution rate | name-match % | Time | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-20 | TypeScript | fixtures/typescript | 12 | 95.2% (20/21) | 0% | 0.5 s | golden fixture |
| 2026-11-20 | TypeScript | this repo (packages + apps) | ~150 | 99.9% (1615/1617) | 0% | 3.2 s | 48 cross-package calls after D18 |
| 2026-11-20 | TypeScript | sindresorhus/ky | 98 | 97.6% (1674/1715) | 0% | 4.7 s | before the D18 fix; network run, unauthenticated |
| 2026-11-20 | TypeScript | sindresorhus/ky @ 3541888 | 98 | 97.6% (1674/1715) | 0% | 7.6 s | lead's final acceptance run (CLI and POST /api/analyses to `done`; graph, deps, search, source verified; traversal gives 404) |
| 2026-11-22 | Python | fixtures/python | 11 | golden | n/a | <1 s | golden fixture, 1 parse-error file |
| 2026-11-22 | Python | psf/requests @ 3c7baaa | 37 | 86.8% (1046/1205) | 2.9% | 0.7 s | D32 denominator; 38.6% over all raw calls; precision sample 39/40 |
| 2026-11-22 | Python | pallets/click @ 08b803c | 91 | 90.3% (4058/4494) | 5.3% | 1.6 s | D32 denominator; 56.0% over all raw calls; precision sample 40/40 |
