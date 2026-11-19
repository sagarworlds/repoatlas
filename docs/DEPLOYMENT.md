# Deployment — Windows Server 2016 + IIS (HttpPlatformHandler)

Production target: one Windows Server 2016 machine running IIS, which already hosts
many other sites. RepoAtlas runs as **one Node.js process** started by
HttpPlatformHandler. That process serves both the API (`/api/*`) and the built
frontend (static files), so there is a single IIS site and nothing else to proxy.

The code must also run on Linux (CI, possible future hosting), so nothing in the app
may depend on IIS — IIS only starts the process and forwards HTTP to it.

## 1. Constraints from the existing server (must follow)

- **HttpPlatformHandler is v1.0.** It silently rejects `workingDirectory`,
  `processesPerApplication`, `startupRetryCount` and `requestTimeout` (result: 502.3,
  no process started, no log). Use **only** these five attributes on `<httpPlatform>`:
  `processPath`, `arguments`, `startupTimeLimit`, `stdoutLogEnabled`, `stdoutLogFile`.
- **No working directory is set**, so the app must never rely on `process.cwd()`:
  - Resolve every path from the module's own location
    (`path.dirname(fileURLToPath(import.meta.url))`) or from absolute config values.
  - Load `.env` from a path computed relative to the server entry file (use
    `process.loadEnvFile(absPath)` if it exists), not from the current directory.
  - `DATA_DIR` must be resolved to an absolute path at startup.
- **Port:** read `process.env.HTTP_PLATFORM_PORT` first, then `PORT`, then 4000.
  Bind to `127.0.0.1` when `HTTP_PLATFORM_PORT` is set.
- **Hosting pattern:** a standalone IIS site on its own free port with a dedicated app
  pool. Never nest it under an existing site.
- **Logs:** HttpPlatformHandler captures stdout. Fastify/pino logs to stdout as JSON.
- PowerShell 5.1 on the server defaults to TLS 1.0: before downloading anything with
  PowerShell, run `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'`.
  `curl.exe` is not available; use `Invoke-WebRequest -UseBasicParsing`.
  (Node itself uses its own TLS stack and is not affected at runtime.)

## 2. Folder layout on the server

```
C:\NodeApps\repoatlas\
├── node\              # portable Node.js (zip distribution), pinned version
├── app\               # deploy bundle: api dist + prod node_modules + web build + grammars
├── site\              # IIS physical path: contains only web.config
├── data\              # DATA_DIR: SQLite DB, extracted sources, temp
├── logs\              # stdout logs
└── .env               # production config (not in git)
```

Use the **portable Node.js zip** inside the app folder (same idea as an embeddable
Python), so this app's Node version is independent of anything else on the server.
Before choosing a Node version, check Node's official supported-platforms list to
confirm it supports Windows Server 2016.

## 3. web.config (`site\web.config`)

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="httpPlatformHandler" path="*" verb="*"
           modules="httpPlatformHandler" resourceType="Unspecified" />
    </handlers>
    <httpPlatform processPath="C:\NodeApps\repoatlas\node\node.exe"
                  arguments="--max-old-space-size=4096 C:\NodeApps\repoatlas\app\apps\api\dist\server.js"
                  startupTimeLimit="60"
                  stdoutLogEnabled="true"
                  stdoutLogFile="C:\NodeApps\repoatlas\logs\stdout" />
  </system.webServer>
</configuration>
```

## 4. App pool and site (PowerShell, run as admin)

```powershell
Import-Module WebAdministration
$pool = "RepoAtlas"
New-WebAppPool -Name $pool
Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ""          # No Managed Code
Set-ItemProperty "IIS:\AppPools\$pool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
Set-ItemProperty "IIS:\AppPools\$pool" -Name processModel.loadUserProfile -Value $true
Set-ItemProperty "IIS:\AppPools\$pool" -Name recycling.periodicRestart.time -Value ([TimeSpan]::Zero)
Set-ItemProperty "IIS:\AppPools\$pool" -Name recycling.disallowOverlappingRotation -Value $true

New-Website -Name "RepoAtlas" -Port 5010 -PhysicalPath "C:\NodeApps\repoatlas\site" -ApplicationPool $pool

icacls "C:\NodeApps\repoatlas\data" /grant "IIS AppPool\RepoAtlas:(OI)(CI)M"
icacls "C:\NodeApps\repoatlas\logs" /grant "IIS AppPool\RepoAtlas:(OI)(CI)M"
```

Port `5010` is a placeholder — pick a free one. Add a host-header binding later if the
site should be reachable by name.

`disallowOverlappingRotation` matters: the job queue is in-process and SQLite is a
single file, so two Node processes must never run at the same time during a recycle.

## 5. Building the deploy bundle

1. On a **Windows x64** machine with the **same Node major version** as the server
   (so `better-sqlite3`'s native binary matches): `pnpm install`, `pnpm build`.
2. `pnpm --filter @repoatlas/api deploy --prod <out>\app` to produce a self-contained
   folder with production `node_modules`.
3. Copy the web build (`apps/web/dist`) and the tree-sitter grammar `.wasm` files into
   the bundle at the paths the API expects (the build script should do this).
4. Copy `<out>\app` to `C:\NodeApps\repoatlas\app`, then recycle the app pool.

Write this as a Node script (`scripts/make-deploy-bundle.ts`), not a shell script.

## 6. App requirements this deployment implies (implement in code)

- `apps/api` serves `apps/web/dist` via `@fastify/static` in production, with SPA
  fallback (unknown non-`/api` routes → `index.html`).
- On startup, analyses left in a non-terminal status (`queued`, `fetching`, `parsing`,
  `resolving`, `persisting`) were interrupted by a restart: re-queue them once, or mark
  them `failed` if they were already retried. Retry counters are kept in
  `DATA_DIR/recovery.json` (DECISIONS D13).
- Graceful shutdown on `SIGINT`/`SIGTERM` and when the parent closes stdin: stop
  accepting jobs, close the DB.
- Behind IIS/ARR set `TRUST_PROXY=1` (one trusted hop) so rate limits see the client
  address; never `true`, which would trust a client-supplied `X-Forwarded-For`. Leave it
  unset if the app is not behind a proxy.
- Temp extraction directories live under `DATA_DIR/tmp`, never the system temp dir
  (the app pool identity may not have rights there), and are cleaned on startup.

## 7. Windows-specific operational notes

- **Antivirus:** real-time scanning of thousands of extracted source files slows
  analysis a lot. Consider a Defender exclusion for `C:\NodeApps\repoatlas\data\sources`
  and `data\tmp` (these files are only read, never executed).
- **Long paths:** some repos contain paths longer than 260 characters. The extractor
  must skip entries whose final absolute path is too long for the OS and count them in
  `skippedFiles` instead of failing.
- **Reserved names and case collisions:** see `docs/SECURITY.md` §3.
- **Outbound access:** the server needs HTTPS access to `api.github.com` and
  `codeload.github.com`. Set `GITHUB_TOKEN` in `.env` to avoid the low anonymous
  rate limit.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 502.3, no stdout log | Unsupported attribute in `<httpPlatform>`, or wrong `processPath` |
| 502.3 after a delay | App did not listen on `HTTP_PLATFORM_PORT` within `startupTimeLimit` |
| App starts but can't write DB | Missing modify rights for `IIS AppPool\RepoAtlas` on `data\` |
| `.env` values missing | Code loaded `.env` relative to cwd instead of the entry file |
| `better-sqlite3` load error | Bundle built on a different OS/arch/Node major version |
| Misleading binding errors | Another (possibly broken) site holds the same port binding |
