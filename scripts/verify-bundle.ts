// Dry run of the deploy bundle: builds one into the OS temp folder and starts it the way
// IIS would (node.exe server.js, HTTP_PLATFORM_PORT set, unrelated working directory).
// Run by hand: pnpm exec tsx scripts/verify-bundle.ts [--bundle <existing-out-dir>]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { CJS_BANNER, repoRoot } from "./build-api.ts";
import { findPackageDir } from "./bundle-deps.ts";
import { GRAMMAR_FILES } from "./grammars.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
  if (!ok) failures++;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base: string, child: ChildProcess): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Builds scripts/smoke-entry.ts into a temporary file next to server.js (so the layout
 * logic sees the real bundle folders), runs it from an unrelated cwd with NO grammar
 * environment variables, and deletes it again.
 */
async function smokeParsePython(out: string, work: string): Promise<void> {
  const distDir = path.join(out, "app", "apps", "api", "dist");
  const smokeJs = path.join(distDir, "smoke-verify.js");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "scripts", "smoke-entry.ts")],
      outfile: smokeJs,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      // Same externals and bundling as server.js; web-tree-sitter is bundled, wasm is on disk.
      external: ["better-sqlite3", "typescript"],
      alias: {
        "web-tree-sitter": path.join(
          findPackageDir("web-tree-sitter", path.join(repoRoot, "packages", "treesitter")),
          "web-tree-sitter.js",
        ),
      },
      banner: { js: CJS_BANNER },
      logLevel: "silent",
    });
    const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: path.join(work, "smoke-data") };
    delete env.GRAMMAR_DIR;
    delete env.TREE_SITTER_WASM_DIR;
    const run = spawnSync(process.execPath, [smokeJs], {
      cwd: path.parse(tmpdir()).root,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    const line = (run.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
    check(
      "bundled web-tree-sitter parses Python via bundle layout (unrelated cwd)",
      run.status === 0,
      line === "" ? (run.stderr ?? "").slice(0, 300) : line,
    );
  } catch (err) {
    check("bundled Python smoke test", false, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(smokeJs, { force: true });
    await rm(`${smokeJs}.map`, { force: true });
  }
}

async function main(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "repoatlas-bundle-"));
  const argBundle = process.argv.indexOf("--bundle");
  const out =
    argBundle >= 0 ? path.resolve(process.argv[argBundle + 1] ?? "") : path.join(work, "out");
  let child: ChildProcess | undefined;
  try {
    if (argBundle < 0) {
      // Use the real web build if present, otherwise a tiny fake one.
      let webDist = path.join(repoRoot, "apps", "web", "dist");
      if (!existsSync(path.join(webDist, "index.html"))) {
        webDist = path.join(work, "fake-web");
        await mkdir(path.join(webDist, "assets"), { recursive: true });
        await writeFile(
          path.join(webDist, "index.html"),
          "<!doctype html><title>atlas-fake</title>",
        );
        await writeFile(path.join(webDist, "assets", "app.js"), "console.log(1)");
        console.log("apps/web/dist not found: using a fake web dist");
      }
      const build = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repoRoot, "scripts", "make-deploy-bundle.ts"),
          "--out",
          out,
          "--web-dist",
          webDist,
        ],
        { cwd: repoRoot, stdio: "inherit" },
      );
      check("bundle script exits 0", build.status === 0);
      if (build.status !== 0) return;
    }

    const serverJs = path.join(out, "app", "apps", "api", "dist", "server.js");
    check("server.js exists in bundle", existsSync(serverJs));
    check("web.config exists", existsSync(path.join(out, "site", "web.config")));
    check("README-DEPLOY.txt exists", existsSync(path.join(out, "README-DEPLOY.txt")));
    check(
      "bundled better-sqlite3 present",
      existsSync(path.join(out, "app", "node_modules", "better-sqlite3", "package.json")),
    );
    check(
      "bundled typescript present",
      existsSync(path.join(out, "app", "node_modules", "typescript", "package.json")),
    );

    const grammarsDir = path.join(out, "app", "grammars");
    for (const g of GRAMMAR_FILES) {
      check(`grammars/${g.file} present`, existsSync(path.join(grammarsDir, g.file)));
    }
    await smokeParsePython(out, work);

    // .env sits OUTSIDE app\ (like C:\NodeApps\repoatlas\.env): proves it is found via the entry file.
    await writeFile(path.join(out, ".env"), "CORS_ORIGIN=http://dry-run.example\n");

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HTTP_PLATFORM_PORT: String(port),
      DATA_DIR: path.join(work, "data"),
    };
    delete env.CORS_ORIGIN;
    delete env.PORT;
    const unrelatedCwd = path.parse(tmpdir()).root; // e.g. C:\ : proves no cwd dependency
    child = spawn(process.execPath, ["--max-old-space-size=4096", serverJs], {
      cwd: unrelatedCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let log = "";
    child.stdout?.on("data", (d: Buffer) => {
      log += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      log += d.toString();
    });
    const exited = new Promise<number | null>((resolve) =>
      child?.once("exit", (code) => resolve(code)),
    );

    const up = await waitForHealth(base, child);
    check("server starts and /api/health answers", up);
    if (!up) {
      console.log(log);
      return;
    }

    const health = await fetch(`${base}/api/health`);
    check(
      "GET /api/health is JSON 200",
      health.status === 200 && (health.headers.get("content-type") ?? "").includes("json"),
      await health.clone().text(),
    );

    const root = await fetch(`${base}/`);
    const rootBody = await root.text();
    check("GET / returns SPA index.html", root.status === 200 && rootBody.includes("<title>"));

    const deep = await fetch(`${base}/a/abc`);
    const deepBody = await deep.text();
    check("GET /a/abc falls back to index.html", deep.status === 200 && deepBody === rootBody);

    const nope = await fetch(`${base}/api/nope`);
    const nopeJson = (await nope.json()) as { error?: { code?: string } };
    check(
      "GET /api/nope is JSON 404 NOT_FOUND",
      nope.status === 404 && nopeJson.error?.code === "NOT_FOUND",
    );

    const cors = await fetch(`${base}/api/health`, {
      headers: { Origin: "http://dry-run.example" },
    });
    check(
      ".env outside app/ was loaded (CORS_ORIGIN)",
      cors.headers.get("access-control-allow-origin") === "http://dry-run.example",
    );

    check("DATA_DIR database created", existsSync(path.join(work, "data", "repoatlas.db")));

    child.stdin?.end(); // what HttpPlatformHandler does to stop the process
    const code = await Promise.race([
      exited,
      new Promise<string>((r) => setTimeout(() => r("timeout"), 15000)),
    ]);
    check(
      "closing stdin shuts down gracefully with exit code 0",
      code === 0,
      `exit=${String(code)}`,
    );
  } finally {
    if (child !== undefined && child.exitCode === null && child.pid !== undefined) {
      child.kill(); // only the process we started
    }
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
