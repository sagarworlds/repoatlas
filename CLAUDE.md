# CLAUDE.md — RepoAtlas

RepoAtlas turns a **public GitHub repository** into an interactive, explorable map of
its folders, files, classes, functions/methods, imports and calls — for **many
languages**, not just TypeScript. ("RepoAtlas" is a working name; rename freely.)

You (Claude Code) are building this project from scratch. This file is the entry point.
Read it fully at the start of every session, then read the docs listed below as needed.

## Documentation map (read in this order on day one)

| Doc | What it defines |
|---|---|
| `docs/ROADMAP.md` | Milestones, task checklists, acceptance criteria. **Your work queue.** |
| `docs/ARCHITECTURE.md` | Monorepo layout, pipeline stages, data flow, tech stack |
| `docs/GRAPH_SCHEMA.md` | The language-neutral graph model. **The core contract.** |
| `docs/LANGUAGE_PLUGINS.md` | Plugin interface, extraction tiers, per-language rules |
| `docs/API.md` | HTTP API endpoints and payloads |
| `docs/UI.md` | Frontend views and interactions |
| `docs/SECURITY.md` | Untrusted-input rules. **Non-negotiable.** |
| `docs/TESTING.md` | Fixture repos, golden-edge tests, quality metrics |
| `docs/DEPLOYMENT.md` | Production hosting on Windows Server + IIS (HttpPlatformHandler) |
| `docs/DECISIONS.md` | Decision log (ADR-lite). Append when you make a notable choice. |

## How to work

1. Open `docs/ROADMAP.md`, find the **first milestone with unchecked tasks**, and work
   through its tasks in order. Do not jump ahead to later milestones.
2. Before writing code for a task, re-read the doc sections it references.
3. Every task that adds behaviour adds or updates tests (see `docs/TESTING.md`).
4. A task is done only when `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass.
   Then tick its checkbox in `docs/ROADMAP.md`.
5. When you choose between real alternatives (library, algorithm, data format), add a
   short entry to `docs/DECISIONS.md`. If a choice contradicts a doc, update the doc in
   the same change — docs must always describe the code as it is.
6. If something in the docs is ambiguous or seems wrong, say so and propose a fix
   rather than silently improvising.
7. Keep commits small and scoped to one task. Commit message: `M<n>: <task summary>`.

## Hard rules

- **Never execute code from an analyzed repository.** No `npm install`, `pip install`,
  `go build`, `mvn`, `gradle`, `cargo`, `make`, `setup.py`, git hooks, or anything that
  runs repo-provided scripts. We only *read and parse* files. See `docs/SECURITY.md`.
- **The graph schema in `packages/schema` is the contract.** Language plugins emit only
  schema types. The UI and API never contain language-specific logic.
- **No language-specific code outside `packages/lang-*`.** If you feel the need, the
  schema or plugin interface is missing something — extend that instead.
- **Cross-platform.** Must run on Linux, macOS and Windows. Use `node:path` for disk
  paths, but node IDs and stored file paths always use forward slashes (`/`), relative
  to the repo root. No bash-only scripts; write scripts in TypeScript/Node.
- **Validate at boundaries** with `zod`: HTTP input, plugin output, stored JSON.
- Do not add a dependency without a reason; note significant ones in `docs/DECISIONS.md`.
- Never commit secrets. Config comes from environment variables (see `.env.example`).
- **Never rely on `process.cwd()`.** In production no working directory is set (see
  `docs/DEPLOYMENT.md`). Resolve paths from the module's location or absolute config;
  load `.env` relative to the entry file. Port: `HTTP_PLATFORM_PORT`, then `PORT`.

## Working with the maintainer

The maintainer is an experienced C# developer who is **learning TypeScript** through this
project. So:

- Prefer clear, explicit TypeScript over clever type-level tricks. Avoid advanced
  conditional/mapped types unless they clearly pay off; when you use one, add a short comment.
- In your end-of-task summary, briefly explain any TypeScript or Node idiom that a C#
  developer might not recognise (e.g. discriminated unions, `satisfies`, ESM imports,
  `async` iteration, zod inference), comparing it to the C# equivalent where helpful.
- When a task has a small, self-contained piece that would be good practice (for example
  one import resolver), point it out so the maintainer can choose to write it themselves.

## Tech stack (summary — details in `docs/ARCHITECTURE.md`)

- Node.js 22+ (24 LTS preferred), TypeScript (strict), ESM only, pnpm workspaces
- Backend: Fastify + zod; SQLite via `better-sqlite3`; in-process job queue for MVP
- Parsing: TypeScript compiler API (TS/JS), `web-tree-sitter` (WASM) for other languages
- Frontend: React + Vite + TanStack Query + Cytoscape.js (+ fcose, dagre) + Shiki
- Tooling: Vitest, Biome (lint + format)

## Commands

```bash
pnpm install          # install workspace deps
pnpm dev              # api (port 4000) + web (port 5173) in watch mode
pnpm test             # vitest across all packages
pnpm typecheck        # tsc --noEmit across all packages
pnpm lint             # biome check
pnpm format           # biome format --write
pnpm analyze <github-url> [--ref <ref>] [--out graph.json]   # CLI: run the pipeline locally
```

(Create these scripts in Milestone 0 if they do not exist yet.)

## Code conventions

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`. No `any`; use `unknown`
  and narrow. Prefer plain functions and data over classes, except for plugin objects.
- File names: `kebab-case.ts`. Types/interfaces: `PascalCase`. Functions: `camelCase`.
- One responsibility per module; keep files under ~400 lines.
- Errors: throw typed errors (`class AnalysisError extends Error { code: ... }`) inside
  the pipeline; the API maps them to HTTP responses. A parse failure in one file must
  never fail the whole analysis — record it in analysis stats and continue.
- Logging via `pino` (Fastify's logger). No `console.log` in library packages.
- Pure functions for extraction and resolution so they are easy to unit test.

## Definition of done for a language

A language counts as "supported" only when it has: a plugin in `packages/lang-<id>`,
a fixture repo in `fixtures/<id>/` with `expected-edges.json`, passing golden tests,
and a row in the support matrix in `docs/LANGUAGE_PLUGINS.md`.
