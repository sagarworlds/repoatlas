import type {
  Confidence,
  EdgeMeta,
  FileExtraction,
  GraphEdge,
  GraphNode,
  Unresolved,
} from "@repoatlas/schema";
import { externalId, fileId, moduleId, parseId } from "@repoatlas/schema";
import type { GoPackageTable } from "../prepare/project-info.ts";
import type { DirData } from "./packages.ts";

/** What a name bound by an import statement stands for. */
export type ImportBinding =
  | { kind: "internal"; dir: DirData; importPath: string }
  | { kind: "external"; id: string };

/** Per-file import information used by reference resolution. */
export interface FileImports {
  /** Local package name (declared name, alias or guess) -> target. */
  bindings: Map<string, ImportBinding>;
  /** Internal packages imported with `import . "path"`. */
  dots: DirData[];
  /** True when some external package is dot-imported (unknown names may come from it). */
  externalDot: boolean;
  /**
   * True when a third-party package is imported without an alias: its real package name is
   * only guessed, so an unknown identifier receiver may be that package.
   */
  guessedExternal: boolean;
}

export type ImportClass =
  | { kind: "internal"; dir: string; importPath: string }
  | { kind: "missing-internal" }
  | { kind: "stdlib" }
  | { kind: "cgo" }
  | { kind: "external"; module: string };

const STDLIB_ID = externalId("go", "stdlib");

function isVersionSegment(segment: string | undefined): boolean {
  return segment !== undefined && /^v\d+$/.test(segment);
}

/**
 * Names a package imported from `path` is likely called by when its real package clause is
 * unknown (external packages): the last segment without `/vN`, without a `.vN` suffix, and
 * without a `go-` prefix or `-go` suffix.
 */
export function packageNameGuesses(path: string): string[] {
  const segments = path.split("/");
  if (segments.length > 1 && isVersionSegment(segments[segments.length - 1])) segments.pop();
  const last = segments[segments.length - 1] ?? path;
  const names = new Set<string>([last]);
  const noVersion = last.replace(/\.v\d+$/, "");
  names.add(noVersion);
  const bare = noVersion.replace(/^go-/, "").replace(/-go$/, "").replace(/\.go$/, "");
  names.add(bare);
  names.add(bare.replace(/^golang-/, ""));
  names.delete("");
  return [...names];
}

/** Module path of a third-party import: the longest `require`d prefix, else a host heuristic. */
function externalModuleOf(path: string, required: ReadonlySet<string>): string {
  const segments = path.split("/");
  for (let n = segments.length; n >= 1; n--) {
    const prefix = segments.slice(0, n).join("/");
    if (required.has(prefix)) return prefix;
  }
  // First three segments (github.com/org/repo, golang.org/x/net); gopkg.in has two.
  const count = segments[0] === "gopkg.in" ? 2 : 3;
  return segments.slice(0, Math.min(count, segments.length)).join("/");
}

export function classifyImport(
  specifier: string,
  table: GoPackageTable,
  required: ReadonlySet<string>,
  hasPackage: (dir: string) => boolean,
): ImportClass {
  const dir = table.importPathToDir.get(specifier);
  if (dir !== undefined && hasPackage(dir)) return { kind: "internal", dir, importPath: specifier };
  const underModule = table.modules.some(
    (m) => specifier === m.path || specifier.startsWith(`${m.path}/`),
  );
  if (underModule) return { kind: "missing-internal" };
  if (specifier === "C") return { kind: "cgo" };
  const first = specifier.split("/")[0] ?? specifier;
  if (!first.includes(".")) return { kind: "stdlib" };
  return { kind: "external", module: externalModuleOf(specifier, required) };
}

interface Accumulator {
  src: string;
  dst: string;
  line: number;
  confidence: Confidence;
  alias: string | undefined;
  packages: Set<string>;
}

export interface ImportAnalysis {
  files: Map<string, FileImports>;
  imports: GraphEdge[];
  externals: GraphNode[];
  unresolved: Unresolved[];
}

function toEdge(acc: Accumulator): GraphEdge {
  const meta: EdgeMeta = {};
  if (acc.alias !== undefined) meta.alias = acc.alias;
  if (acc.dst.startsWith("ext:")) {
    const packages = [...acc.packages].sort();
    meta.package = packages[0];
    meta.packages = packages;
  }
  const edge: GraphEdge = {
    src: acc.src,
    dst: acc.dst,
    kind: "imports",
    confidence: acc.confidence,
    line: acc.line,
  };
  if (Object.keys(meta).length > 0) edge.meta = meta;
  return edge;
}

function externalNode(id: string): GraphNode {
  const parsed = parseId(id);
  return {
    id,
    kind: "external",
    name: parsed?.kind === "external" ? parsed.pkg : id,
    meta: { ecosystem: "go" },
  };
}

/**
 * Classifies every import of every file and builds the per-file binding tables, the
 * file-level `imports` edges (one per file and target, sorted) and the external nodes.
 *
 * Confidence: an internal package found through a go.mod is `exact` (decided by layout);
 * everything that rests on a naming convention (module-less layouts, stdlib / third-party
 * shape rules) is `inferred`, except that with at least one go.mod in the repo the
 * stdlib / third-party classification is `exact` too.
 */
export function analyzeImports(
  extractions: readonly FileExtraction[],
  dirs: ReadonlyMap<string, DirData>,
  table: GoPackageTable,
): ImportAnalysis {
  const required = new Set(table.requiredModules);
  const hasPackage = (dir: string): boolean => dirs.get(dir)?.primary !== undefined;
  const externalConfidence: Confidence = table.modules.length > 0 ? "exact" : "inferred";
  const accumulators = new Map<string, Accumulator>();
  const externalIds = new Set<string>();
  const files = new Map<string, FileImports>();
  const unresolved: Unresolved[] = [];

  const accumulate = (
    src: string,
    dst: string,
    line: number,
    confidence: Confidence,
    alias: string | undefined,
    pkg: string | undefined,
  ): void => {
    const key = `${src}\0${dst}`;
    let acc = accumulators.get(key);
    if (!acc) {
      acc = { src, dst, line, confidence, alias, packages: new Set() };
      accumulators.set(key, acc);
    } else {
      acc.line = Math.min(acc.line, line);
      if (confidence === "exact") acc.confidence = "exact";
      acc.alias ??= alias;
    }
    if (pkg !== undefined) acc.packages.add(pkg);
  };

  for (const extraction of extractions) {
    const fileImports: FileImports = {
      bindings: new Map(),
      dots: [],
      externalDot: false,
      guessedExternal: false,
    };
    files.set(extraction.file, fileImports);
    const src = fileId(extraction.file);
    for (const imp of extraction.imports) {
      const isDot = imp.kind === "wildcard" || imp.alias === ".";
      const isBlank = imp.kind === "side-effect" || imp.alias === "_";
      const alias =
        imp.alias === undefined || imp.alias === "." || imp.alias === "_" ? undefined : imp.alias;
      const cls = classifyImport(imp.specifier, table, required, hasPackage);
      if (cls.kind === "missing-internal") {
        unresolved.push({
          file: extraction.file,
          line: imp.line,
          name: imp.specifier,
          kind: "import",
        });
        continue;
      }
      if (cls.kind === "internal") {
        const dirData = dirs.get(cls.dir);
        if (!dirData) continue;
        const confidence: Confidence = table.moduleDirs.has(cls.dir) ? "exact" : "inferred";
        accumulate(src, moduleId("go", cls.importPath), imp.line, confidence, alias, undefined);
        if (isDot) fileImports.dots.push(dirData);
        else if (!isBlank) {
          const name = alias ?? dirData.primary?.name ?? packageNameGuesses(cls.importPath)[0];
          if (name !== undefined) {
            fileImports.bindings.set(name, {
              kind: "internal",
              dir: dirData,
              importPath: cls.importPath,
            });
          }
        }
        continue;
      }
      const id =
        cls.kind === "stdlib"
          ? STDLIB_ID
          : cls.kind === "cgo"
            ? externalId("go", "cgo")
            : externalId("go", cls.module);
      externalIds.add(id);
      accumulate(src, id, imp.line, externalConfidence, alias, imp.specifier);
      if (isDot) fileImports.externalDot = true;
      else if (!isBlank) {
        if (alias === undefined && cls.kind === "external") fileImports.guessedExternal = true;
        const names = alias === undefined ? packageNameGuesses(imp.specifier) : [alias];
        for (const name of names) {
          if (!fileImports.bindings.has(name))
            fileImports.bindings.set(name, { kind: "external", id });
        }
      }
    }
  }

  const imports = [...accumulators.values()]
    .map(toEdge)
    .sort((a, b) =>
      a.src === b.src ? (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0) : a.src < b.src ? -1 : 1,
    );
  const externals = [...externalIds].sort().map(externalNode);
  return { files, imports, externals, unresolved };
}
