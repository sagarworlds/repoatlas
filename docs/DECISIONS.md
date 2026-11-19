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

---

## Real-repo smoke results
| Date | Language | Repo @ sha | Files | Resolution rate | name-match % | Time | Notes |
|---|---|---|---|---|---|---|---|
