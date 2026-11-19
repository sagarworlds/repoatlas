# Roadmap

Work top to bottom. Tick `[x]` when a task meets the definition of done in `CLAUDE.md`.
Each milestone ends with its **acceptance check** — do it before moving on.

---

## M0 — Scaffold

- [ ] pnpm workspace with `packages/*`, `apps/*`; `tsconfig.base.json` (strict,
      `noUncheckedIndexedAccess`, ESM, `moduleResolution: bundler` for web /
      `NodeNext` for node packages); per-package `tsconfig.json` with project references.
- [ ] Biome config; root scripts `dev`, `test`, `typecheck`, `lint`, `format`, `analyze`.
- [ ] Vitest workspace config; one trivial test per package so `pnpm test` runs.
- [ ] Empty packages: `schema`, `plugin-api`, `core`, `treesitter`, `store`,
      `lang-typescript`; apps: `api`, `web`, `cli`.
- [ ] `.env.example` (see ARCHITECTURE §8), config loader with zod in `apps/api`.
- [ ] GitHub Actions CI (ubuntu + windows): typecheck, lint, test.
- [ ] `docs/DECISIONS.md` entry for anything you changed from the docs.

**Acceptance:** fresh clone → `pnpm install && pnpm typecheck && pnpm lint && pnpm test`
all green on Linux and Windows CI; `pnpm dev` starts api (`/api/health` responds) and
web (blank page with app name).

---

## M1 — Schema, fetch, pipeline skeleton, TypeScript plugin, store, API

- [ ] `packages/schema`: types + zod schemas from `GRAPH_SCHEMA.md`; ID helpers with
      unit tests (POSIX paths, collision suffix, external IDs incl. scoped npm names).
- [ ] `packages/plugin-api`: `LanguagePlugin`, `SymbolIndex` types, stoplist, helpers.
- [ ] `core`: GitHub URL parser/validator (+ security tests).
- [ ] `core`: `Fetcher` interface; `GitHubFetcher` (ref → SHA, size check, tarball
      download) and `LocalDirFetcher` (tests).
- [ ] `core`: safe tar extraction (+ malicious tarball tests, SECURITY §7).
- [ ] `core`: walker + filters (ignored dirs: `.git`, `node_modules`, `vendor`, `dist`,
      `build`, `target`, `bin`, `obj`, `__pycache__`, `.venv`, `venv`; binary detection;
      size; minified/generated rules).
- [ ] `core`: language detection by extension; plugin registry.
- [ ] `core`: orchestrator running stages 1–11 (ARCHITECTURE §3), progress callbacks,
      per-phase timings, error isolation per file and per plugin, edge validation,
      duplicate edge merging, structure nodes, stats.
- [ ] `lang-typescript` (Tier 3, TS only for now): program creation from tsconfig with
      overrides, definitions, imports (internal/external), calls via TypeChecker,
      extends/implements, workspace package mapping.
- [ ] `fixtures/typescript` + `expected-edges.json`; golden test passing.
- [ ] `store`: migrations, `GraphStore` interface + SQLite impl, bulk insert in one
      transaction, queries: subgraph, node detail, callflow, deps, search (FTS5).
- [ ] `core`: rollup computation (dir and file level).
- [ ] `apps/api`: all endpoints in `API.md`, in-process queue, cache by commit SHA,
      rate limiting, helmet, CORS, error mapping; API tests with `inject()`.
- [ ] `apps/cli`: `pnpm analyze <url> [--ref] [--out]` prints stats, optional JSON dump.
- [ ] Startup recovery: re-queue (once) or fail analyses left mid-run by a restart;
      clean `DATA_DIR/tmp`; graceful shutdown (DEPLOYMENT §6).
- [ ] Config never depends on `process.cwd()`; port from `HTTP_PLATFORM_PORT` then `PORT`.

**Acceptance:** `pnpm analyze https://github.com/sindresorhus/ky` completes, prints
stats with TS resolution rate ≥ 90%, and the same analysis via `POST /api/analyses`
reaches `done`; `GET /graph`, `/callflow`, `/deps`, `/search`, `/source` return
sensible data.

---

## M2 — Frontend explorer

- [ ] App shell, routing, theme (light/dark), API client + TanStack Query hooks, typed
      with `schema` types.
- [ ] Home page: form with validation, examples, recent (localStorage + API).
- [ ] Progress view with polling and failure state.
- [ ] Explorer layout: header, file tree, canvas, detail panel, code panel (resizable).
- [ ] Map tab: compound dir nodes, expand/focus, breadcrumb, toolbar filters, hover
      highlight, sizing by degree, confidence styling, PNG export.
- [ ] Call flow tab: dagre LR layout, depth controls, re-focus with history, edge →
      call-site line in code panel.
- [ ] Dependencies tab: three-column view, depth control, externals grouped.
- [ ] Detail panel and code panel (Shiki, lazy languages, GitHub link, copy, fullscreen).
- [ ] Search (Ctrl/Cmd+K, `/`).
- [ ] URL-driven state; empty/loading/error states; responsive drawers < 900px.
- [ ] Production build: API serves `apps/web/dist` with SPA fallback.
- [ ] `scripts/make-deploy-bundle.ts` and a dry-run deployment following
      `docs/DEPLOYMENT.md` (web.config, app pool, permissions) on the Windows server.

**Acceptance:** analyzing `pmndrs/zustand` from the home page lands on a usable map;
selecting a function shows its call flow; selecting a file shows its dependencies; the
code panel shows the right lines; a shared URL reopens the same view. The same works
when deployed on IIS, including after an app pool recycle.

---

## M3 — Tree-sitter engine + Python

- [ ] `packages/treesitter`: `web-tree-sitter` init, grammar loading (pinned versions,
      "all grammars load" test), query runner, definition tree building, reference →
      enclosing definition attachment, per-file timeout.
- [ ] Generic resolver helpers in `plugin-api` implementing LANGUAGE_PLUGINS §5 steps
      as composable functions (self/super lookup, binding-map lookup, same-module lookup,
      local-variable type inference, name-match with stoplist).
- [ ] `lang-python`: spec + queries, `prepare` (package roots from layout/pyproject),
      import resolution (absolute, relative, aliased, wildcard, `__init__` re-export),
      method/self handling, decorators, `__init__` constructor calls, test detection.
- [ ] `fixtures/python` + golden test.
- [ ] Polyglot check: fixture with TS + Python in one repo produces one coherent graph.
- [ ] UI: low-resolution banner, language chips reflect stats.

**Acceptance:** analyze 2 real Python repos (< 300 files); resolution rate ≥ 65%;
`name-match` share < 20%; record results in `DECISIONS.md`.

---

## M4 — JavaScript, Go, Java

- [ ] JavaScript through `lang-typescript` (`allowJs`, CommonJS `require`/`module.exports`,
      ESM, `index.js` resolution) + `fixtures/javascript`.
- [ ] `lang-go` (go.mod, package-per-directory scope, receiver methods, stdlib grouping)
      + fixture.
- [ ] `lang-java` (packages, imports incl. wildcard/static, nested classes, overload
      disambiguation by arg count) + fixture.
- [ ] Worker-thread pool for extraction (keep single-thread fallback for debugging).
- [ ] Per-file extraction cache by content hash.

**Acceptance:** each language meets its TESTING §4 target on 2 real repos.

---

## M5 — C#, Rust, PHP, Ruby

- [ ] `lang-csharp` (namespace map, usings/aliases, partial classes, csproj packages).
- [ ] `lang-rust` (Cargo crates/workspaces, module tree, `use` forms, impl/trait blocks).
- [ ] `lang-php` (PSR-4 from composer.json, `use` forms, `$this`/`self`/`parent`/static).
- [ ] `lang-ruby` (reopened classes, require/require_relative, Rails/Zeitwerk heuristic,
      mixins, bare-identifier call rule).
- [ ] Fixtures + golden tests for each.

**Acceptance:** each language meets its target; support matrix updated.

---

## M6 — Precision tier (optional, needs sandbox)

- [ ] Design doc in `DECISIONS.md`: sandbox technology, resource limits, network policy.
- [ ] SCIP ingestion: parse `index.scip` (protobuf) → map occurrences to our node IDs →
      upgrade matching edges to `exact`, add missing ones.
- [ ] Start with one indexer (e.g. scip-python or scip-java), behind a feature flag.

**Acceptance:** on the same repo, Tier 2 run increases `exact` share without lowering
resolution rate; sandbox escape tests documented.

---

## M7 — C / C++

- [ ] `lang-cpp`: include resolution (relative, CMake dirs, common dirs,
      compile_commands.json read-only), header/definition linking, namespaces, classes.
- [ ] Fixture + golden test; accept lower targets.

---

## Later (keep the design friendly to these)

- Incremental re-analysis on new commits (diff file hashes).
- Cross-language edges (frontend HTTP calls ↔ backend route handlers) — heuristic.
- Kotlin, Swift, Scala, Dart.
- GraphRAG: embeddings per symbol (signature + docstring + body summary), graph-aware
  retrieval, evals; then agents that propose pull requests with human approval.
