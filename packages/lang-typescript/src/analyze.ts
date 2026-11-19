import type { PluginProjectInfo, ProjectContext, RepoView } from "@repoatlas/plugin-api";
import {
  type FileExtraction,
  fileId,
  type GraphEdge,
  type GraphNode,
  type RawImport,
  type ResolutionResult,
  symbolId,
  type Unresolved,
} from "@repoatlas/schema";
import ts from "typescript";
import { collectDefinitions } from "./definitions.ts";
import { type EdgeExtraction, extractFileEdges, type NodeRef } from "./edges.ts";
import { collectImports, type ImportSite } from "./imports.ts";
import { createImportResolver } from "./resolve-imports.ts";
import { readTsconfigOptions } from "./tsconfig.ts";
import { createVirtualHost, toVirtualPath } from "./virtual-host.ts";
import {
  buildWorkspacePackages,
  type WorkspacePackages,
  workspacePathMappings,
} from "./workspaces.ts";

/** Plugin-private data computed by `prepare` and consumed by `analyzeProject`. */
export interface TypeScriptProjectInfo {
  /** Compiler options after RepoAtlas overrides (plain JSON-able object). */
  compilerOptions: ts.CompilerOptions;
  workspacePackages: WorkspacePackages;
  tsconfigPath?: string;
}

export function computeProjectInfo(repo: RepoView): TypeScriptProjectInfo {
  const { options, tsconfigPath } = readTsconfigOptions(repo);
  const info: TypeScriptProjectInfo = {
    compilerOptions: options,
    workspacePackages: buildWorkspacePackages(repo),
  };
  if (tsconfigPath !== undefined) info.tsconfigPath = tsconfigPath;
  return info;
}

/** PluginProjectInfo is `Record<string, unknown>`: narrow it back, recomputing if absent. */
function readProjectInfo(info: PluginProjectInfo, repo: RepoView): TypeScriptProjectInfo {
  const options = info.compilerOptions;
  const packages = info.workspacePackages;
  if (
    typeof options === "object" &&
    options !== null &&
    typeof packages === "object" &&
    packages !== null
  ) {
    return {
      compilerOptions: options as ts.CompilerOptions,
      workspacePackages: packages as WorkspacePackages,
    };
  }
  return computeProjectInfo(repo);
}

/** Accumulates one imports edge per (file, target), merging several imports of the same thing. */
class ImportEdgeBuilder {
  private readonly byKey = new Map<
    string,
    {
      src: string;
      dst: string;
      line: number;
      names: Set<string>;
      alias: string | undefined;
      specifiers: Set<string>;
      allDynamic: boolean;
      allTypeOnly: boolean;
      reexport: boolean;
      builtin: boolean;
    }
  >();

  add(src: string, dst: string, site: ImportSite, builtin: boolean): void {
    const key = `${src}\u0000${dst}`;
    let acc = this.byKey.get(key);
    if (!acc) {
      acc = {
        src,
        dst,
        line: site.raw.line,
        names: new Set(),
        alias: undefined,
        specifiers: new Set(),
        allDynamic: true,
        allTypeOnly: true,
        reexport: false,
        builtin,
      };
      this.byKey.set(key, acc);
    }
    for (const n of site.raw.names ?? []) acc.names.add(n.name);
    acc.alias ??= site.raw.alias;
    acc.specifiers.add(site.raw.specifier);
    acc.allDynamic &&= site.raw.kind === "dynamic";
    acc.allTypeOnly &&= site.typeOnly;
    acc.reexport ||= site.reexport;
  }

  build(): GraphEdge[] {
    return [...this.byKey.values()].map((a) => {
      const meta: NonNullable<GraphEdge["meta"]> = {};
      if (a.names.size > 0) meta.importedNames = [...a.names].sort();
      if (a.alias !== undefined) meta.alias = a.alias;
      if (a.allDynamic) meta.isDynamic = true;
      if (a.allTypeOnly) meta.isTypeOnly = true;
      if (a.reexport) meta.isReexport = true;
      if (a.builtin) {
        const specs = [...a.specifiers].sort();
        meta.package = specs[0];
        meta.packages = specs;
      }
      return { src: a.src, dst: a.dst, kind: "imports", confidence: "exact", line: a.line, meta };
    });
  }
}

/**
 * Tier 3 whole-project analysis: one ts.Program over every claimed file, then definitions,
 * imports and TypeChecker-resolved edges (LANGUAGE_PLUGINS section 6).
 */
export async function analyzeTypeScriptProject(
  ctx: ProjectContext,
  info: PluginProjectInfo,
): Promise<{ extractions: FileExtraction[]; resolution: ResolutionResult }> {
  const projectInfo = readProjectInfo(info, ctx.repo);
  const { workspacePackages } = projectInfo;
  // The project's own `paths` win; workspace packages fill in what it does not map.
  const compilerOptions: ts.CompilerOptions = {
    ...projectInfo.compilerOptions,
    paths: {
      ...workspacePathMappings(ctx.repo, workspacePackages, toVirtualPath),
      ...projectInfo.compilerOptions.paths,
    },
  };

  const sourcePaths = [...new Set(ctx.files.map((f) => f.path))].sort();
  // Ambient declaration files help type resolution but are not extracted themselves.
  const ambientPaths = ctx.allFiles
    .map((f) => f.path)
    .filter((p) => p.endsWith(".d.ts") && !sourcePaths.includes(p))
    .sort();

  const host = createVirtualHost(ctx.repo, compilerOptions);
  const program = ts.createProgram({
    rootNames: [...sourcePaths, ...ambientPaths].map(toVirtualPath),
    options: compilerOptions,
    host,
  });
  // Creating the checker binds every file, which also sets all `parent` pointers we rely on.
  const checker = program.getTypeChecker();
  const resolver = createImportResolver({
    repo: ctx.repo,
    options: compilerOptions,
    host,
    workspacePackages,
  });

  // Pass 1: definitions for all files (edges need the global declaration -> node map).
  const nodes = new Map<ts.Node, NodeRef>();
  const files: { path: string; sf: ts.SourceFile }[] = [];
  const extractions: FileExtraction[] = [];
  const importsByFile = new Map<string, ImportSite[]>();

  for (const path of sourcePaths) {
    const sf = program.getSourceFile(toVirtualPath(path));
    if (!sf) {
      // Unreadable file: keep an empty extraction so the file still appears in the graph.
      extractions.push({
        file: path,
        language: "typescript",
        definitions: [],
        imports: [],
        references: [],
        parseErrors: 0,
      });
      continue;
    }
    let collected: ReturnType<typeof collectDefinitions>;
    let sites: ImportSite[];
    try {
      collected = collectDefinitions(sf, path);
      sites = collectImports(sf);
    } catch {
      // One pathological file must not take the whole project down: keep it as an empty
      // file and flag it through parseErrors.
      extractions.push({
        file: path,
        language: "typescript",
        definitions: [],
        imports: [],
        references: [],
        parseErrors: 1,
      });
      continue;
    }
    for (const [decl, { localId, kind }] of collected.localIdByDecl) {
      nodes.set(decl, { id: symbolId(path, localId), kind });
    }
    importsByFile.set(path, sites);
    files.push({ path, sf });
    extractions.push({
      file: path,
      language: "typescript",
      definitions: collected.definitions,
      imports: sites.map((s): RawImport => s.raw),
      // References are resolved right here (edges below), so the raw list stays empty.
      references: [],
      // Cheap and correct: syntactic diagnostics are the parser's own errors.
      parseErrors: program.getSyntacticDiagnostics(sf).length,
    });
  }

  // Pass 2: imports -> edges and externals.
  const importEdges = new ImportEdgeBuilder();
  const externals = new Map<string, GraphNode>();
  const unresolved: Unresolved[] = [];
  for (const { path } of files) {
    for (const site of importsByFile.get(path) ?? []) {
      const resolved = resolver.resolve(site.raw.specifier, path);
      if (resolved.kind === "file") {
        if (resolved.path !== path)
          importEdges.add(fileId(path), fileId(resolved.path), site, false);
      } else if (resolved.kind === "external") {
        const t = resolved.target;
        if (!externals.has(t.id)) {
          externals.set(t.id, {
            id: t.id,
            kind: "external",
            name: t.name,
            meta: { ecosystem: t.kind === "npm" ? "npm" : "node" },
          });
        }
        importEdges.add(fileId(path), t.id, site, t.kind === "builtin");
      } else if (resolved.kind === "unresolved") {
        unresolved.push({
          file: path,
          line: site.raw.line,
          name: site.raw.specifier,
          kind: "import",
        });
      }
    }
  }

  // Pass 3: calls / extends / implements / references via the TypeChecker.
  const edges: GraphEdge[] = [];
  for (const { path, sf } of files) {
    try {
      const result: EdgeExtraction = extractFileEdges(sf, path, checker, nodes);
      edges.push(...result.edges);
      unresolved.push(...result.unresolved);
    } catch {
      // The checker can still fail on a single odd file; the rest of the edges survive.
    }
  }

  return {
    extractions,
    resolution: {
      imports: importEdges.build(),
      edges,
      externals: [...externals.values()].sort((a, b) => a.id.localeCompare(b.id)),
      unresolved,
    },
  };
}
