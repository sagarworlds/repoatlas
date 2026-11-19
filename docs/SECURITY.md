# Security

Every analyzed repository is **untrusted input**, and anyone on the internet can submit
any URL. These rules are mandatory; tests must cover them.

## 1. Never execute repository code
- No package installs, builds, test runs, scripts, git hooks, or code generation from
  the repo. No `child_process` calls with repo-derived arguments.
- Manifests (`package.json`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`,
  `*.csproj`, `Cargo.toml`, `composer.json`, `Gemfile`, `CMakeLists.txt`) are **parsed
  as data** with safe parsers (JSON, TOML, XML with entity expansion disabled). Never
  `eval`/`require`/`import` them. `build.gradle(.kts)` and `Gemfile` are code: extract
  what you need with simple regexes only, or skip.
- The TypeScript compiler is used for analysis only (no emit, no plugins from tsconfig,
  no `types` auto-inclusion).
- Tier 2 (SCIP indexers, M6) runs only in a sandbox: container/microVM, no network after
  a controlled dependency-fetch step, read-only source mount, CPU/memory/time limits,
  non-root user. Until that sandbox exists, Tier 2 stays disabled.

## 2. URL validation
- Accept only `https://github.com/{owner}/{repo}` (optionally `/tree/{ref}`, `.git`
  suffix) and the `owner/repo` shorthand. Regex for owner/repo:
  `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` and `^[A-Za-z0-9._-]{1,100}$`.
- Build GitHub API URLs ourselves from the parsed parts; never fetch a user-supplied URL
  directly (prevents SSRF). Validate `ref` (`^[A-Za-z0-9._/-]{1,200}$`, no `..`).
- The parser is deliberately strict: `www.github.com`, ports, query strings and fragments
  are rejected (not stripped), as are `%`, `@`, backslashes, whitespace, control
  characters and any `..` in a ref. Redirects are followed manually (max 5), only to the
  API origin or `https://codeload.github.com`; the token is sent only to the API origin.
- Reject private repos (API `private: true` or 404) and repos whose reported size
  exceeds the limit before downloading.

## 3. Safe archive extraction
- Stream the tarball; abort when compressed bytes > `MAX_TARBALL_BYTES` or extracted
  bytes > 3× that, or file count > `MAX_FILES`.
- For each entry: strip the top-level `{owner}-{repo}-{sha}/` folder; reject absolute
  paths, `..` segments, drive letters/backslashes, and NUL bytes; skip **symlinks and
  hardlinks** entirely; skip device files; skip files > `MAX_FILE_BYTES`.
- Resolve the final path and assert it is inside the extraction directory
  (`path.resolve(dest, p).startsWith(path.resolve(dest) + path.sep)`).
- Extract into a fresh temp dir per analysis; files are written with no execute bits.
- **Windows-safe names:** skip (and count in `skippedFiles`) entries whose path, on
  Windows, would be invalid or ambiguous: reserved device names in any segment (`CON`,
  `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without extension),
  characters `< > : " | ? *` or control chars, segments ending in a dot or space, and
  paths whose final absolute length exceeds the OS limit. Apply the same rules on
  every OS so results are identical everywhere.
- Skip reasons reported: `unsafe-path`, `reserved-name`, `path-too-long`, `symlink`,
  `hardlink`, `special-file`, `too-large-file`, `case-collision`, `duplicate`,
  `path-conflict`. Every non-directory entry counts against `MAX_FILES` (including skipped
  ones); the zip-bomb guard counts gunzipped input bytes; received bytes per file are
  re-checked against `MAX_FILE_BYTES` (the header size is not trusted).
- **Case collisions:** if two entries differ only by letter case (`README.md` vs
  `readme.md`), keep the first and skip the rest (case-insensitive filesystems).

## 4. Resource limits
- Per-analysis wall-clock timeout (`ANALYSIS_TIMEOUT_MS`); per-file parse timeout
  (tree-sitter: set a timeout/progress callback; TS: chunk work). Exceeded → mark file
  skipped, continue; whole-analysis timeout → `failed`.
- Skip minified/generated files: average line length > 300, or a single line > 10,000
  chars, or known generated markers (`@generated`, `DO NOT EDIT`, `*.min.js`, `*.pb.go`,
  `*_pb2.py`, lockfiles).
- Cap nodes/edges per analysis (e.g. 500k / 2M); beyond that, stop and mark stats
  `truncated`.
- Job concurrency cap; worker threads have memory limits (`resourceLimits`).

## 5. Serving data
- Source endpoint: look the file up among the analysis's `file` nodes; never join the
  query parameter onto a filesystem path. Return as JSON text; the frontend renders via
  Shiki (escaped HTML) — never `dangerouslySetInnerHTML` with raw repo content.
- Node names, signatures and paths are repo-controlled strings: always render as text.
- Security headers (`@fastify/helmet`), CORS restricted to the web origin, rate limits
  (see `docs/API.md`).

## 6. Secrets
- `GITHUB_TOKEN` stays server-side; never sent to the client or logged.
- Do not log repository file contents.

## 7. Required tests
- Tar fixtures with: `../evil`, absolute path, symlink to `/etc/passwd`, hardlink,
  oversized file, too many files, zip-bomb-like ratio, `aux.js`, `a:b.ts`, trailing-dot
  names, case-colliding names → all rejected/skipped safely.
- URL validator: SSRF attempts (`https://github.com.evil.com/...`, `http://`,
  `git@...`, `file://`, encoded `..`) → rejected.
- Source endpoint: `file=../../etc/passwd` → 404 `FILE_NOT_FOUND`.
