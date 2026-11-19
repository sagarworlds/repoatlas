# HTTP API

Base path: `/api`. JSON only. All inputs validated with zod (use
`fastify-type-provider-zod`). Errors use one shape:

```json
{ "error": { "code": "INVALID_REPO_URL", "message": "Only public github.com repositories are supported." } }
```

Error codes and HTTP status:

| Status | Codes |
|---|---|
| 400 | `INVALID_REPO_URL`, `VALIDATION_ERROR` (bad body/query/malformed JSON, control characters in ids, `start` > `end`) |
| 403 | `REPO_PRIVATE` |
| 404 | `REPO_NOT_FOUND`, `ANALYSIS_NOT_FOUND`, `NODE_NOT_FOUND`, `FILE_NOT_FOUND`, `NOT_FOUND` (unknown route) |
| 409 | `ANALYSIS_NOT_READY` (queued, running or failed analysis) |
| 422 | `REPO_TOO_LARGE`, `NO_SUPPORTED_LANGUAGES` |
| 429 | `RATE_LIMITED` (our limiter, or GitHub's rate limit while resolving the ref) |
| 500 | `INTERNAL` (generic message, details only in logs; `CANCELLED` also maps here) |
| 504 | `TIMEOUT` (resolving the ref in `POST`; also stored as a failed analysis' error code) |

A failed analysis exposes its code in `error` (`GET /api/analyses/:id`); it can be any
pipeline code above plus `TIMEOUT`.

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
`ref` optional (default branch). The ref is resolved to a commit SHA **before** anything
is queued, so `REPO_NOT_FOUND`, `REPO_PRIVATE`, `RATE_LIMITED` and `TIMEOUT` are HTTP
errors of this call. Response `202` (new or already in flight for the same repo/ref; the
existing id is returned) or `200` (cached: a finished analysis of the same
`(owner, repo, commitSha, analyzerVersion)`):
```json
{ "id": "an_01J...", "status": "queued", "owner": "pmndrs", "repo": "zustand",
  "ref": "main", "commitSha": "a1b2c3...", "cached": false }
```
`ref` is the resolved ref (the default branch name when none was given). `status` shows
the current status when an in-flight analysis is reused.

### `GET /api/analyses/:id`
```json
{
  "id": "an_01J...", "owner": "pmndrs", "repo": "zustand", "ref": "main",
  "commitSha": "a1b2c3...", "status": "parsing",
  "progress": { "phase": "parsing", "filesDone": 120, "filesTotal": 300 },
  "stats": null,                      // AnalysisStats when done (see GRAPH_SCHEMA §5)
  "error": null,                      // { "code": "...", "message": "..." } when failed
  "createdAt": "...", "finishedAt": null
}
```

### `GET /api/analyses?limit=20`
Recent analyses (global, newest first), `limit` 1-100 (rejected with 400 outside). Returns
`{ "analyses": [ ...same shape as GET /api/analyses/:id ] }`. Used for example/recent
lists. The UI also keeps the user's own recent IDs in `localStorage`.

All endpoints below return `409 ANALYSIS_NOT_READY` unless the analysis is `done`.

---

## Graph

### `GET /api/analyses/:id/graph`
Level-of-detail subgraph for the codebase map.

Query:
| Param | Values | Meaning |
|---|---|---|
| `level` | `dir` \| `file` \| `symbol` | granularity of returned nodes |
| `root` | node ID, default `dir:` | only descendants of this node |
| `depth` | 1–5, default 2; **rejected with 400 outside the range** | levels of `contains` below root to include |
| `edgeKinds` | csv of EdgeKind | default `imports,calls` (aggregated at dir/file level); `contains` is never returned as an edge, use `parentId` |
| `includeTests` | `true`/`false`, default `false` | drops test files and directories made only of test files; at dir/file level also excludes test edges from the weights |
| `includeExternal` | default `false` | adds `ext:` nodes and `imports` edges at file/symbol level (never at dir level) |
| `minConfidence` | `exact` \| `inferred` \| `name-match` (default) | at dir/file level only edges at or above it are counted in the weights |

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
lowest-degree leaf nodes beyond the cap (the tree stays connected). Collection itself stops
at 4x the node cap (breadth first), also setting `truncated`. `meta.degree` lets the UI
size nodes by connectedness. `root: "repo:"` is treated as `dir:`; an unknown root returns
an empty graph.

At `dir`/`file` level edges are pre-aggregated rollups (`weight` = summed imports/calls,
see GRAPH_SCHEMA §6) with confidence `inferred` (`exact` when `minConfidence=exact`). At
`symbol` level they are real edges.

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
Callers (up) and callees (down) of a function/method. Depth is **clamped** to 0-4 each
(never rejected); at most 500 nodes. Each edge
includes `line` (call site) and `confidence`; each node includes `signature`.
```json
{ "focus": "sym:src/auth.ts#resendVerification",
  "nodes": [ ... ], "edges": [ { "src": "...", "dst": "...", "kind": "calls",
  "line": 163, "confidence": "exact", "meta": { "callCount": 1 } } ] }
```

### `GET /api/analyses/:id/deps?file=src/auth/auth.service.ts&direction=both&depth=1`
`direction`: `imports` | `importedBy` | `both`. Depth is **clamped** to 1-3. Returns file
nodes (+ external nodes when `imports`) and `imports` edges; the walk continues only
through file nodes; at most 500 nodes. `file` must be a file of the analysis
(`NODE_NOT_FOUND` otherwise).

### `GET /api/analyses/:id/search?q=resend&kinds=function,method,class,file&limit=20`
Substring search over `name` and `qualifiedName`, case-insensitive: FTS5 trigram for 3+
characters, bound `LIKE` for 1-2. `q` is 1-200 characters, `limit` 1-100 (rejected with 400
outside), control characters are rejected. Ranked: exact name > prefix > substring; ties by
degree. Returns `{ "results": [ ...GraphNode ] }`.

---

## Source

### `GET /api/analyses/:id/source?file=src/auth.ts&start=150&end=200`
`start`/`end` optional (whole file). Returns raw text; the UI highlights it.
```json
{ "file": "src/auth.ts", "language": "typescript", "startLine": 150, "endLine": 200,
  "totalLines": 412, "content": "..." }
```
`file` must be a file of this analysis (looked up in `nodes`; `FILE_NOT_FOUND` otherwise),
user input is never joined onto a path directly; the resolved path is re-checked inside
`DATA_DIR/sources/{commitSha}` and after `realpath`. Files over 1 MB are `FILE_NOT_FOUND`.
Line endings are normalized to `\n`; a trailing newline does not count as a line.
`start` > `end`, or `start` beyond the file, is `400 VALIDATION_ERROR`. An empty file
returns `startLine: 0, endLine: 0`.

---

## Health

`GET /api/health` → `{ "ok": true, "version": "...", "analyzerVersion": "..." }`

## Rate limiting

`@fastify/rate-limit`: `POST /api/analyses` 10/hour per IP; other routes 300/min per IP
(`RATE_LIMIT_*` env vars). The client IP is the socket address unless `TRUST_PROXY` is set
(hop count behind IIS, never `true`; see `docs/DEPLOYMENT.md`). CORS allows the single
origin `CORS_ORIGIN`.
