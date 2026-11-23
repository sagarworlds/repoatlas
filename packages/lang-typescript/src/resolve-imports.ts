import type { RepoView } from "@repoatlas/plugin-api";
import ts from "typescript";
import { type ExternalTarget, externalTargetFor } from "./module-names.ts";
import { toRepoPath, toVirtualPath } from "./virtual-host.ts";
import { resolveWorkspaceImport, type WorkspacePackages } from "./workspaces.ts";

export type ResolvedImport =
  /** Resolved to a file of this repository (POSIX repo-relative path). */
  | { kind: "file"; path: string }
  | { kind: "external"; target: ExternalTarget }
  /** Looks internal but cannot be found (missing file, unmapped alias). */
  | { kind: "unresolved" }
  /** URLs and other schemes we deliberately do not model. */
  | { kind: "ignored" };

export interface ImportResolver {
  resolve(specifier: string, fromFile: string): ResolvedImport;
}

// Files a relative import may point at when TypeScript resolution found nothing (e.g. a
// .json file, or a .js file the program did not know about). allowJs is on, so TypeScript
// itself already resolves .js/.jsx/.mjs/.cjs and index.js; this is only a safety net.
const FALLBACK_EXTENSIONS = ["", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function joinPosix(fromFile: string, specifier: string): string | undefined {
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export function createImportResolver(args: {
  repo: RepoView;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  workspacePackages: WorkspacePackages;
}): ImportResolver {
  const { repo, options, host, workspacePackages } = args;
  const cache = ts.createModuleResolutionCache("/repo", (f) => f, options);

  const isRepoFile = (p: string): boolean => repo.exists(p) && !repo.isDir(p);

  return {
    resolve(specifier, fromFile) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith("node:")) {
        return { kind: "ignored" };
      }
      if (specifier.startsWith("node:")) {
        const builtin = externalTargetFor(specifier);
        return builtin ? { kind: "external", target: builtin } : { kind: "unresolved" };
      }

      // 1. TypeScript's own resolution: relative paths, baseUrl, tsconfig "paths".
      const result = ts.resolveModuleName(
        specifier,
        toVirtualPath(fromFile),
        options,
        host,
        cache,
      ).resolvedModule;
      if (result && !result.isExternalLibraryImport) {
        const rel = toRepoPath(result.resolvedFileName);
        if (rel !== undefined && !rel.includes("node_modules/") && isRepoFile(rel)) {
          return { kind: "file", path: rel };
        }
      }

      // 2. Relative imports of non-TS files (.js, .json) or directories with an index.
      if (specifier.startsWith(".")) {
        const base = joinPosix(fromFile, specifier);
        if (base !== undefined) {
          for (const ext of FALLBACK_EXTENSIONS) {
            if (isRepoFile(base + ext)) return { kind: "file", path: base + ext };
          }
          for (const idx of ["index.js", "index.jsx", "index.mjs", "index.cjs"]) {
            const p = base === "" ? idx : `${base}/${idx}`;
            if (isRepoFile(p)) return { kind: "file", path: p };
          }
        }
        return { kind: "unresolved" };
      }

      // 3. Workspace packages: "@acme/utils" -> packages/utils/src/index.ts
      const workspaceFile = resolveWorkspaceImport(repo, workspacePackages, specifier);
      if (workspaceFile !== undefined) return { kind: "file", path: workspaceFile };
      if (isWorkspaceName(workspacePackages, specifier)) return { kind: "unresolved" };

      // 4. Builtins and third-party packages (node_modules never exists).
      const target = externalTargetFor(specifier);
      return target ? { kind: "external", target } : { kind: "unresolved" };
    },
  };
}

function isWorkspaceName(packages: WorkspacePackages, specifier: string): boolean {
  return Object.keys(packages).some((n) => specifier === n || specifier.startsWith(`${n}/`));
}
