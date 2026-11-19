# Architecture

## 1. Goals and non-goals

**Goals**
- Analyze any public GitHub repository from its URL, without executing its code.
- Produce one language-neutral graph: directories → files → classes/types →
  functions/methods, connected by `contains`, `imports`, `calls`, `extends`,
  `implements`, `references` edges.
- Support many languages through plugins, with honest confidence levels on edges.
- Let users explore the graph at multiple zoom levels, inspect call flow and
  dependencies, and read source next to the graph.

**Non-goals (for now)**
- Private repositories, authentication, multi-user accounts.
- Executing builds or tests of analyzed repos.
- Runtime/dynamic call tracing.
- Editing code. (Agents / GraphRAG come later; keep the graph store friendly to them.)

## 2. Monorepo layout

```
repoatlas/
├── CLAUDE.md
├── package.json               # workspace root scripts
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
├── .env.example
├── docs/
├── fixtures/                  # small test repos per language (see TESTING.md)
│   ├── typescript/
│   ├── python/
│   └── ...
├── packages/
│   ├── schema/                # graph types + zod schemas + ID helpers (no deps on others)
│   ├── core/                  # pipeline: fetch, walk, detect, orchestrate, resolve, aggregate
│   ├── plugin-api/            # LanguagePlugin interface + shared helpers for plugins
│   ├── treesitter/            # generic tree-sitter engine (loading grammars, running queries)
│   ├── store/                 # SQLite persistence + graph queries
│   ├── lang-typescript/       # TS/JS via TypeScript compiler API (Tier 3)
│   ├── lang-python/           # tree-sitter spec + Python import resolver
│   ├── lang-go/
│   ├── lang-java/
│   ├── lang-csharp/
│   ├── lang-rust/
│   ├── lang-php/
│   ├── lang-ruby/
│   └── lang-cpp/
└── apps/
    ├── api/                   # Fastify HTTP server + job queue
    ├── web/                   # React frontend
    └── cli/                   # `pnpm analyze` command for local runs and debugging
```

Dependency direction (must stay acyclic):

```
schema ← plugin-api ← treesitter ← lang-*
schema ← core (core depends on plugin-api, loads lang-* via a registry)
schema ← store
api → core, store, schema       web → schema (types only)       cli → core
```

`apps/web` imports only **types** from `packages/schema` — never runtime code from
`core`, `store` or plugins.

## 3. Analysis pipeline

```
 URL ──► 1 Validate ──► 2 Fetch ──► 3 Walk & filter ──► 4 Detect languages
                                                          │
            ┌─────────────────────────────────────────────┘
            ▼
 5 Extract (per file, per plugin, parallel) ──► 6 Index symbols
            │
            ▼
 7 Resolve references (per plugin, needs global index) ──► 8 Build structure nodes
            │
            ▼
 9 Aggregate (dir/file-level rollups) ──► 10 Persist ──► 11 Stats & done
```

| Stage | Responsibility | Package |
|---|---|---|
| 1 Validate | Parse `https://github.com/{owner}/{repo}[/tree/{ref}]`, normalize, reject anything else | core |
| 2 Fetch | Resolve ref → commit SHA via GitHub REST API; download tarball; safe extraction to a temp dir | core |
| 3 Walk & filter | List files; skip ignored dirs, binaries, oversized, minified, generated, vendored. Enforces `MAX_FILES` (`REPO_TOO_LARGE`) and cancellation | core |
| 4 Detect | Map each file to a plugin by extension (+ shebang/filename rules); count bytes per language | core |
| 5 Extract | Plugin parses each file → `FileExtraction` (definitions, raw imports, raw references) | lang-* |
| 6 Index | Build `SymbolIndex`: by file, by qualified name, by short name, by module path | core |
| 7 Resolve | Plugin turns raw imports/references into edges using the index; sets `confidence` | lang-* |
| 8 Structure | Create `repo`, `directory`, `file` nodes and `contains` edges (only for claimed source files, plus non-source files an edge points at) | core |
| 9 Aggregate | Precompute directory→directory and file→file dependency counts for zoomed-out views | core |
| 10 Persist | Write nodes, edges, source snapshot, stats to the store in one transaction | store |
| 11 Stats | Record per-phase timings, counts, parse errors, resolution rates | core |

Notes:
- **Cache key** is `(owner, repo, commitSha, analyzerVersion)`. If it exists, skip
  re-analysis and return the existing result.
- **Per-file extraction cache** keyed by `(pluginId, pluginVersion, contentHash)` so a
  later commit only re-parses changed files. (Implement in a later milestone.)
- Stages 5 and 7 are split so that extraction is embarrassingly parallel and pure,
  while resolution has access to the whole repo's symbol index.
- Stage order in code: extract, index, resolve, structure (file nodes need the surviving
  extractions), validate, rollups. Progress phases emitted: `fetching`, `parsing`,
  `resolving`; the caller reports `persisting`.
- The **TypeScript plugin** does extraction and resolution together inside a TS
  `Program` (the type checker resolves everything); it still emits the same output types.

## 4. Fetching repositories

- Resolve the ref: `GET https://api.github.com/repos/{owner}/{repo}` (default branch,
  size, visibility), then `GET /repos/{owner}/{repo}/commits/{ref}` for the SHA.
- Download: `GET https://api.github.com/repos/{owner}/{repo}/tarball/{sha}` (follows a
  redirect to codeload). Use `GITHUB_TOKEN` from env if present (higher rate limit).
- **Do not use `git clone`** — tarballs avoid hooks, submodule fetching and LFS.
- Stream-extract with `tar` (npm) applying the rules in `docs/SECURITY.md`
  (no symlinks, no absolute paths, no `..`, size/file-count caps).
- Store the extracted source under `DATA_DIR/sources/{sha}/` so the code viewer can
  serve file contents later. Delete sources when no done or in-flight analysis uses them
  (eviction, or right after a failure). Layout and retention: DECISIONS D12.

## 5. Job model

- `POST /api/analyses` creates an `analysis` row with status `queued` and enqueues it.
- MVP queue: in-process, concurrency from `ANALYSIS_CONCURRENCY` (default 2), using
  `p-queue`. Design the job function so it can later move to BullMQ/Redis or a worker
  process without changes to the pipeline code.
- Status: `queued → fetching → parsing → resolving → persisting → done | failed`.
  Progress is reported as `{ phase, filesDone, filesTotal }` and polled by the UI.
- Run CPU-heavy extraction in `worker_threads` (pool size = CPU cores − 1) once the
  single-threaded version works. Keep plugin functions serializable-input/output to allow this.

## 6. Storage

SQLite (`better-sqlite3`), file at `DATA_DIR/repoatlas.db`. WAL mode on.

Tables (sketch — exact DDL lives in `packages/store/src/migrations/`):

- `analyses(id, owner, repo, ref, commit_sha, analyzer_version, status, phase,
  progress_json, stats_json, error, created_at, finished_at)`
- `nodes(analysis_id, id, kind, name, qualified_name, language, file, start_line,
  end_line, signature, parent_id, meta_json)` — PK `(analysis_id, id)`
- `edges(analysis_id, src, dst, kind, confidence, line, meta_json)` — index on
  `(analysis_id, src, kind)` and `(analysis_id, dst, kind)`
- `rollups(analysis_id, level, src, dst, kind, weight, include_tests, min_confidence)` —
  aggregated edges for zoomed views, one row per variant (see GRAPH_SCHEMA §6)
- `unresolved(analysis_id, file, line, name, kind)` — references we could not resolve
  (for stats and debugging; not shown as edges)

Queries the API needs (implement as functions in `store`): subgraph by level and root,
node detail, callers/callees to depth N, file imports/importers, full-text-ish search
on names (SQLite FTS5 table with the `trigram` tokenizer on `name`, `qualified_name`).
Migrations are TS modules holding SQL, tracked in `PRAGMA user_version`.

Keep the store behind an interface (`GraphStore`) so Postgres or a graph DB can be
swapped in later for GraphRAG.

## 7. Frontend overview

See `docs/UI.md`. The frontend talks only to the HTTP API. Large graphs are never sent
in full: the API returns level-of-detail subgraphs and the UI expands on demand.

## 8. Configuration (`.env.example`)

```
PORT=4000                     # in production HTTP_PLATFORM_PORT takes precedence
DATA_DIR=./data
GITHUB_TOKEN=                 # optional, raises GitHub API rate limit
ANALYSIS_CONCURRENCY=2
MAX_TARBALL_BYTES=209715200   # 200 MB
MAX_FILES=20000
MAX_FILE_BYTES=1048576        # 1 MB
ANALYSIS_TIMEOUT_MS=600000    # 10 min
CACHE_MAX_ANALYSES=200        # newest finished (done or failed) analyses kept
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:5173
TRUST_PROXY=false             # hop count (IIS: 1), "loopback" or false; never "true"
RATE_LIMIT_ANALYSES_MAX=10
RATE_LIMIT_ANALYSES_WINDOW_MS=3600000
RATE_LIMIT_GENERAL_MAX=300
RATE_LIMIT_GENERAL_WINDOW_MS=60000
WEB_DIST_DIR=                 # default apps/web/dist, served only if it exists
EXIT_ON_STDIN_CLOSE=          # default on when HTTP_PLATFORM_PORT is set
```

In production the API process also serves the built frontend (`apps/web/dist`) with
`@fastify/static`, so a deployment is a single process. See `docs/DEPLOYMENT.md`.

## 9. Versioning

- `ANALYZER_VERSION` constant in `core`: bump when output for the same input changes.
- Each plugin has its own `version`; included in extraction cache keys.
- `SCHEMA_VERSION` in `schema`: bump on breaking schema changes; store it per analysis.
