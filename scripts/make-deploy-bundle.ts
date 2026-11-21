// Builds the IIS deploy bundle (docs/DEPLOYMENT.md section 5).
// Run: pnpm bundle -- --out <dir> [--root C:\NodeApps\repoatlas] [--skip-build] [--web-dist <dir>]
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApi, repoRoot } from "./build-api.ts";
import { copyProductionPackages } from "./bundle-deps.ts";
import {
  parseBundleArgs,
  renderBundlePackageJson,
  renderDeployReadme,
  renderWebConfig,
} from "./bundle-lib.ts";
import { API_EXTERNALS } from "./externals.ts";

/** Total size of a folder in bytes. */
function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function buildWeb(): void {
  // Fixed command, no user input. shell:true is needed on Windows to run pnpm.cmd.
  const result = spawnSync("pnpm --filter @repoatlas/web build", {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) throw new Error("Web build failed");
}

async function main(): Promise<void> {
  const args = parseBundleArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  const webDist = path.resolve(args.webDist ?? path.join(repoRoot, "apps", "web", "dist"));

  if (!args.skipBuild && args.webDist === undefined) buildWeb();
  if (!existsSync(path.join(webDist, "index.html"))) {
    throw new Error(`Web build not found: ${webDist}\\index.html (run the web build first)`);
  }
  if (!args.skipBuild) await buildApi();
  {
    const serverJs = path.join(repoRoot, "apps", "api", "dist", "server.js");
    if (!existsSync(serverJs)) throw new Error(`API bundle not found: ${serverJs}`);

    rmSync(out, { recursive: true, force: true });
    const appDir = path.join(out, "app");
    const apiDist = path.join(appDir, "apps", "api", "dist");
    mkdirSync(apiDist, { recursive: true });
    cpSync(path.dirname(serverJs), apiDist, { recursive: true });
    cpSync(webDist, path.join(appDir, "apps", "web", "dist"), { recursive: true });

    // Production externals come from the workspace install, so versions match the lockfile.
    const versions = copyProductionPackages(
      API_EXTERNALS,
      {
        "better-sqlite3": path.join(repoRoot, "packages", "store"),
        typescript: path.join(repoRoot, "packages", "lang-typescript"),
      },
      appDir,
    );
    const pinned: Record<string, string> = {};
    for (const name of API_EXTERNALS) pinned[name] = versions[name] ?? "";
    writeFileSync(path.join(appDir, "package.json"), renderBundlePackageJson(pinned));

    mkdirSync(path.join(out, "site"), { recursive: true });
    writeFileSync(path.join(out, "site", "web.config"), renderWebConfig(args.root));
    cpSync(path.join(repoRoot, ".env.example"), path.join(out, ".env.example"));
    writeFileSync(
      path.join(out, "README-DEPLOY.txt"),
      renderDeployReadme(args.root, process.version).replace(/\r?\n/g, "\r\n"),
    );

    console.log(`Bundle written to ${out}`);
    console.log(`  app/apps/api/dist   ${mb(dirSize(apiDist))}`);
    console.log(`  app/apps/web/dist   ${mb(dirSize(path.join(appDir, "apps", "web", "dist")))}`);
    console.log(
      `  app/node_modules    ${mb(dirSize(path.join(appDir, "node_modules")))} (${Object.entries(
        versions,
      )
        .map(([n, v]) => `${n}@${v}`)
        .join(", ")})`,
    );
    console.log(`  total               ${mb(dirSize(out))}`);
    console.log(
      `NOTE: better-sqlite3 is native. This bundle only runs on ${process.platform}/${process.arch} with Node ${process.versions.node.split(".")[0]}.x (build on Windows x64 with the server's Node major).`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
