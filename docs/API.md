# HTTP API

Base path: `/api`. JSON only. All inputs validated with zod (use
`fastify-type-provider-zod`). Errors use one shape:

```json
{ "error": { "code": "INVALID_REPO_URL", "message": "Only public github.com repositories are supported." } }
```

Error codes: `INVALID_REPO_URL`, `REPO_NOT_FOUND`, `REPO_TOO_LARGE`, `REPO_PRIVATE`,
`NO_SUPPORTED_LANGUAGES`, `RATE_LIMITED`, `ANALYSIS_NOT_FOUND`, `ANALYSIS_NOT_READY`,
`NODE_NOT_FOUND`, `FILE_NOT_FOUND`, `INTERNAL`.

Path parameters that contain node IDs or file paths are passed as **query
parameters** (URL-encoded), never in the path, because they contain `/`, `#`, `:`.

---

## Analyses

### `POST /api/analyses`
Start (or reuse) an analysis.

Request:
```json
{ "repoUrl": "https://github.com/pmndrs/zustand", "ref": "main" }
```
`ref` optional (default branch). Response `202` (new) or `200` (cached, already done):
```json
{ "id": "an_01J...", "status": "queued", "owner": "pmndrs", "repo": "zustand",
  "ref": "main", "commitSha": null, "cached": false }
```

### `GET /api/analyses/:id`
```json
{
  "id": "an_01J...", "owner": "pmndrs", "repo": "zustand", "ref": "main",
  "commitSha": "a1b2c3...", "status": "parsing",
  "progress": { "phase": "parsing", "filesDone": 120, "filesTotal": 300 },
  "stats": null,                      // AnalysisStats when done (see GRAPH_SCHEMA §5)
  "error": null,
  "createdAt": "...", "finishedAt": null
}
```

### `GET /api/analyses?limit=20`
Recent analyses (global, newest first) — used for example/recent lists. The UI also
keeps the user's own recent IDs in `localStorage`.

---

## Graph

### `GET /api/analyses/:id/graph`
Level-of-detail subgraph for the codebase map.

Query:
| Param | Values | Meaning |
|---|---|---|
| `level` | `dir` \| `file` \| `symbol` | granularity of returned nodes |
| `root` | node ID, default `dir:` | only descendants of this node |
| `depth` | 1–5, default 2 | levels of `contains` below root to include |
| `edgeKinds` | csv of EdgeKind | default `imports,calls` (aggregated at dir/file level) |
| `includeTests` | `true`/`false`, default `false` | |
| `includeExternal` | default `false` | |
| `minConfidence` | `exact` \| `inferred` \| `name-match` (default) | |

Response:
```json
{
  "nodes": [ { "id": "dir:src", "kind": "directory", "name": "src",
               "parentId": "dir:", "meta": { "childCount": 14, "loc": 5200,
               "degree": 37 } } ],
  "edges": [ { "src": "dir:src/core", "dst": "dir:src/utils", "kind": "imports",
               "weight": 12, "confidence": "inferred" } ],
  "truncated": false
}
```
Hard cap: 2,000 nodes / 6,000 edges per response; set `truncated: true` and drop the
lowest-degree nodes beyond the cap. `meta.degree` lets the UI size nodes by connectedness.

### `GET /api/analyses/:id/node?nodeId=...`
Node detail panel.
```json
{
  "node": { ...GraphNode },
  "parents": [ ...breadcrumb nodes from repo to direct parent ],
  "children": [ ...direct contained nodes (methods of a class, symbols of a file) ],
  "counts": { "callers": 4, "callees": 9, "importedBy": 3, "imports": 7 }
}
```

### `GET /api/analyses/:id/callflow?nodeId=...&depthUp=1&depthDown=2`
Callers (up) and callees (down) of a function/method. Depth max 4 each. Each edge
includes `line` (call site) and `confidence`; each node includes `signature`.
```json
{ "focus": "sym:src/auth.ts#resendVerification",
  "nodes": [ ... ], "edges": [ { "src": "...", "dst": "...", "kind": "calls",
  "line": 163, "confidence": "exact", "meta": { "callCount": 1 } } ] }
```

### `GET /api/analyses/:id/deps?file=src/auth/auth.service.ts&direction=both&depth=1`
`direction`: `imports` | `importedBy` | `both`. Depth max 3. Returns file nodes
(+ external nodes when `imports`) and `imports` edges.

### `GET /api/analyses/:id/search?q=resend&kinds=function,method,class,file&limit=20`
Prefix/substring search over `name` and `qualifiedName` (FTS5). Ranked: exact name >
prefix > substring; ties by degree.

---

## Source

### `GET /api/analyses/:id/source?file=src/auth.ts&start=150&end=200`
`start`/`end` optional (whole file). Returns raw text; the UI highlights it.
```json
{ "file": "src/auth.ts", "language": "typescript", "startLine": 150, "endLine": 200,
  "totalLines": 412, "content": "..." }
```
Must validate that `file` is a file of this analysis (look it up in `nodes`), never
join user input onto a filesystem path directly. Max 1 MB.

---

## Health

`GET /api/health` → `{ "ok": true, "version": "...", "analyzerVersion": "..." }`

## Rate limiting

`@fastify/rate-limit`: `POST /api/analyses` 10/hour per IP; other routes 300/min per IP.
