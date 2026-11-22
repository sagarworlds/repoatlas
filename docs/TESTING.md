# Testing

Vitest everywhere. Tests live next to code (`*.test.ts`). `pnpm test` runs all.

## 1. Layers

| Layer | What | Where |
|---|---|---|
| Unit | ID helpers, URL parsing, path filters, per-language import resolution functions, signature formatting | each package |
| Plugin golden | Run a plugin over its fixture repo; compare against `expected-edges.json` | `packages/lang-*/test/` |
| Pipeline | Run the full pipeline on a fixture directory (no network: inject a local "fetcher") | `packages/core/test/` |
| Store | Insert a small graph, test each query (subgraph, callflow, deps, search) | `packages/store/test/` |
| API | Fastify `inject()` against a seeded store; validation + error codes | `apps/api/test/` |
| Security | Malicious tarballs, URL validator, source path traversal | `packages/core/test/security/`, `apps/api/test/` |
| UI | Component tests for panels with mocked API (Vitest + Testing Library); one smoke e2e later (Playwright) | `apps/web` |

The pipeline must accept a pluggable `Fetcher` (`GitHubFetcher` in production,
`LocalDirFetcher` in tests) so tests never hit the network.

## 2. Fixture repos

Each language has a tiny but tricky project in `fixtures/<lang>/` (5–10 files) that
exercises:

1. A class with methods, one calling another via `self`/`this`.
2. Inheritance: subclass calling an inherited method; `super` call.
3. Cross-file import of a function and a class; an **aliased** import.
4. A relative import (where the language has them) and a package/namespace import.
5. A call to an external library (must produce one `imports → external`, no call edge).
6. A static/class-level call (`User.create()`).
7. A local variable with obvious type: `u = User(); u.save()`.
8. A circular import between two files.
9. A deliberately ambiguous call that should be `name-match` or unresolved.
10. A test file (must get `isTest`).
11. One file with a syntax error (analysis must still succeed; `parseErrors > 0`).

### `expected-edges.json`
```json
{
  "mustContainNodes": [
    { "id": "sym:app/models.py#User.save", "kind": "method" }
  ],
  "mustContainEdges": [
    { "src": "sym:app/service.py#register", "dst": "sym:app/models.py#User.save", "kind": "calls", "minConfidence": "inferred" },
    { "src": "file:app/service.py", "dst": "ext:pypi:requests", "kind": "imports" }
  ],
  "mustNotContainEdges": [
    { "src": "sym:app/service.py#register", "dst": "ext:pypi:requests", "kind": "calls" }
  ],
  "minResolutionRate": 0.8
}
```
Optional extra keys used by the golden helper (`packages/core/test/golden-assert.ts`):
`mustContainNodes[].meta` (partial meta match), `mustBeUnresolved`, `parseErrorFiles`.
Golden tests assert containment (not exact equality) so adding new correct edges does
not break them. Snapshotting the stats object's counts (`toMatchSnapshot`) is not done yet.

Golden tests for Python and the polyglot fixture live in `packages/core/test/python-golden.test.ts`
(`lang-python` does not depend on `core`). `ExpectedGraph` also accepts `expectLanguages` and
`noCrossLanguageEdges`. Engine and extractor tests need the real WASM grammar; they run offline.

## 3. Real-repo smoke runs (manual, not CI)

`pnpm analyze https://github.com/<owner>/<repo>` prints stats. Keep a list in
`docs/DECISIONS.md` of repos tried per language with resolution rate, confidence mix,
timing and notable failures. Suggested small repos: one per language, < 300 files.

## 4. Quality metrics to watch

- **Resolution rate** = resolved / total references (per language), where total =
  resolved + unresolved internal-resolvable references; externals, builtins and calls through
  parameters are excluded (DECISIONS D32). Targets for v1:
  TS ≥ 90%, Go/Java/C# ≥ 75%, Python/PHP/Rust ≥ 65%, Ruby/C++ ≥ 50%.
- **Confidence mix**: share of `name-match` edges should be < 20% outside Ruby/C++.
- **Dropped invalid edges** must be 0 in fixtures (it indicates an ID bug).
- **Time**: a 1,000-file repo should analyze in < 60 s on a 4-core machine (excluding download).

## 5. CI

GitHub Actions: install (pnpm cache) → `pnpm typecheck` → `pnpm lint` → `pnpm test`,
on `ubuntu-latest` and `windows-latest` (path handling must work on both).
