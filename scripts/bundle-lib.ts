// Pure helpers for scripts/make-deploy-bundle.ts (no file system, no processes), so they
// are easy to unit test.

export const DEFAULT_SERVER_ROOT = "C:\\NodeApps\\repoatlas";

export interface BundleArgs {
  out: string;
  /** Install root on the Windows server (used only to write paths into web.config). */
  root: string;
  skipBuild: boolean;
  /** Use this prebuilt web dist instead of running the web build (testing/dry runs). */
  webDist: string | undefined;
}

/** True for control characters and characters Windows forbids in paths (except \ : /). */
function hasInvalidPathChars(value: string): boolean {
  return [...value].some((ch) => ch.charCodeAt(0) < 32 || '"<>|?*'.includes(ch));
}

/** Parses `--out <dir> [--root <dir>] [--skip-build] [--web-dist <dir>]`. Throws on anything else. */
export function parseBundleArgs(argv: readonly string[]): BundleArgs {
  let out: string | undefined;
  let root = DEFAULT_SERVER_ROOT;
  let skipBuild = false;
  let webDist: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--out" || arg === "--root" || arg === "--web-dist") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new Error(`${arg} needs a value`);
      }
      i++;
      if (arg === "--out") out = value;
      else if (arg === "--web-dist") webDist = value;
      else root = value;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  if (out === undefined) throw new Error("Missing required --out <dir>");
  if (hasInvalidPathChars(root)) throw new Error("--root contains invalid characters");
  return { out, root: root.replace(/[\\/]+$/, ""), skipBuild, webDist };
}

/** Escapes a string for use inside a double-quoted XML attribute. */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Joins Windows path parts with backslashes regardless of the OS running this script. */
export function winJoin(root: string, ...parts: string[]): string {
  return [root.replace(/[\\/]+$/, ""), ...parts].join("\\");
}

/**
 * The only attributes HttpPlatformHandler v1.0 accepts on <httpPlatform>
 * (docs/DEPLOYMENT.md section 1). Anything else gives a silent 502.3.
 */
export const ALLOWED_HTTP_PLATFORM_ATTRIBUTES = [
  "processPath",
  "arguments",
  "startupTimeLimit",
  "stdoutLogEnabled",
  "stdoutLogFile",
] as const;

/** Generates site\web.config from the template in docs/DEPLOYMENT.md section 3. */
export function renderWebConfig(root: string): string {
  const attrs: Record<(typeof ALLOWED_HTTP_PLATFORM_ATTRIBUTES)[number], string> = {
    processPath: winJoin(root, "node", "node.exe"),
    arguments: `--max-old-space-size=4096 ${winJoin(root, "app", "apps", "api", "dist", "server.js")}`,
    startupTimeLimit: "60",
    stdoutLogEnabled: "true",
    stdoutLogFile: winJoin(root, "logs", "stdout"),
  };
  const lines = ALLOWED_HTTP_PLATFORM_ATTRIBUTES.map(
    (name) => `${name}="${escapeXmlAttr(attrs[name])}"`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="httpPlatformHandler" path="*" verb="*"
           modules="httpPlatformHandler" resourceType="Unspecified" />
    </handlers>
    <httpPlatform ${lines.join("\n                  ")} />
  </system.webServer>
</configuration>
`;
}

/** Minimal package.json for the production folder (externals pinned to lockfile versions). */
export function renderBundlePackageJson(dependencies: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify(
    {
      name: "repoatlas-deploy",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: sorted,
    },
    null,
    2,
  )}\n`;
}

/** README-DEPLOY.txt: the steps from docs/DEPLOYMENT.md sections 4-5, for this root. */
export function renderDeployReadme(root: string, nodeVersion: string): string {
  const r = root;
  return `RepoAtlas deploy bundle
=======================

Built with Node ${nodeVersion} on ${process.platform}/${process.arch}.
The native module better-sqlite3 inside app\\node_modules matches ONLY that OS, CPU and
Node major version. The server must be Windows x64 with the same Node major version.

Bundle contents
  app\\apps\\api\\dist\\server.js   API bundle (+ .map)
  app\\apps\\web\\dist             built frontend (served by the API)
  app\\node_modules               production externals (better-sqlite3, typescript)
  site\\web.config               IIS site config (paths for ${r})
  .env.example                  copy to ${winJoin(r, ".env")} and edit

Steps (docs/DEPLOYMENT.md sections 2, 4, 5)
 1. Create ${r} with the folders: node, app, site, data, logs.
    Unzip the portable Node.js (same major version as above) into ${winJoin(r, "node")}
    so that ${winJoin(r, "node", "node.exe")} exists.
 2. Copy this bundle's app\\ over ${winJoin(r, "app")}, site\\web.config to ${winJoin(r, "site", "web.config")},
    and .env.example to ${winJoin(r, ".env")} (then edit it: set TRUST_PROXY=1, GITHUB_TOKEN, CORS_ORIGIN).
    Relative DATA_DIR resolves against ${r}, not against app\\.
 3. In an elevated PowerShell, create the app pool and site (port 5010 is a placeholder):

      Import-Module WebAdministration
      $pool = "RepoAtlas"
      New-WebAppPool -Name $pool
      Set-ItemProperty "IIS:\\AppPools\\$pool" -Name managedRuntimeVersion -Value ""
      Set-ItemProperty "IIS:\\AppPools\\$pool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
      Set-ItemProperty "IIS:\\AppPools\\$pool" -Name processModel.loadUserProfile -Value $true
      Set-ItemProperty "IIS:\\AppPools\\$pool" -Name recycling.periodicRestart.time -Value ([TimeSpan]::Zero)
      Set-ItemProperty "IIS:\\AppPools\\$pool" -Name recycling.disallowOverlappingRotation -Value $true

      New-Website -Name "RepoAtlas" -Port 5010 -PhysicalPath "${winJoin(r, "site")}" -ApplicationPool $pool

      icacls "${winJoin(r, "data")}" /grant "IIS AppPool\\RepoAtlas:(OI)(CI)M"
      icacls "${winJoin(r, "logs")}" /grant "IIS AppPool\\RepoAtlas:(OI)(CI)M"

 4. Recycle the app pool (Restart-WebAppPool RepoAtlas) and browse to http://localhost:5010/
    (GET /api/health should return JSON).

Updating: copy the new app\\ over ${winJoin(r, "app")}, then recycle the app pool.

Troubleshooting: 502.3 with no stdout log means an unsupported attribute in web.config or a
wrong processPath. "better-sqlite3 load error" means the bundle was built on a different
OS/arch/Node major. See docs/DEPLOYMENT.md section 8.
`;
}
