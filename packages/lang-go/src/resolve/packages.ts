import type { SymbolIndex } from "@repoatlas/plugin-api";
import type { Definition, FileExtraction, GraphNode } from "@repoatlas/schema";
import { symbolId } from "@repoatlas/schema";
import { compareCodeUnits, dirOf } from "../prepare/project-info.ts";

/**
 * One Go package scope: the files of one directory that share a package clause. Test files
 * with the same clause (internal tests) join the package; `foo_test` files form their own.
 */
export interface PackageData {
  dir: string;
  /** The package clause name. */
  name: string;
  extractions: FileExtraction[];
  /** Top-level functions and types of all files (test files included). */
  topAll: Map<string, GraphNode[]>;
  /** Top-level functions and types of the non-test files only. */
  topNonTest: Map<string, GraphNode[]>;
  /** Receiver type name -> method name -> node, across all files of the package. */
  methods: Map<string, Map<string, GraphNode>>;
  /** Package-level variable name -> the file that declares it and its type hint. */
  vars: Map<string, { file: string; hint: string }>;
}

/** All packages of one directory. `primary` is the importable (non-test) package. */
export interface DirData {
  dir: string;
  groups: PackageData[];
  primary: PackageData | undefined;
}

export function isGoTestFile(extraction: FileExtraction): boolean {
  return extraction.meta?.["go.test"] === true || extraction.file.endsWith("_test.go");
}

export function packageNameOf(extraction: FileExtraction): string {
  const declared = extraction.meta?.["go.package"];
  if (typeof declared === "string" && declared !== "") return declared;
  const dir = dirOf(extraction.file);
  return dir.slice(dir.lastIndexOf("/") + 1) || "main";
}

export function isExportedName(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

/** Receiver type name of a method definition: `meta["go.receiver"]`, else the localId prefix. */
export function receiverOf(def: Definition): string {
  const meta = def.meta?.["go.receiver"];
  if (typeof meta === "string" && meta !== "") {
    const stripped = meta.replace(/^\*+/, "");
    const bracket = stripped.indexOf("[");
    return bracket >= 0 ? stripped.slice(0, bracket) : stripped;
  }
  const dot = def.localId.indexOf(".");
  return dot > 0 ? def.localId.slice(0, dot) : def.localId;
}

/** Method name without a `Receiver.` prefix. */
export function methodNameOf(def: Definition): string {
  return def.name.slice(def.name.lastIndexOf(".") + 1);
}

function push(map: Map<string, GraphNode[]>, key: string, node: GraphNode): void {
  const list = map.get(key);
  if (list) list.push(node);
  else map.set(key, [node]);
}

function buildPackage(
  dir: string,
  name: string,
  extractions: FileExtraction[],
  index: SymbolIndex,
): PackageData {
  const data: PackageData = {
    dir,
    name,
    extractions,
    topAll: new Map(),
    topNonTest: new Map(),
    methods: new Map(),
    vars: new Map(),
  };
  for (const ex of extractions) {
    const isTest = isGoTestFile(ex);
    const declared = ex.meta?.["go.vars"];
    if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
      for (const [name, hint] of Object.entries(declared)) {
        if (typeof hint === "string" && !data.vars.has(name)) {
          data.vars.set(name, { file: ex.file, hint });
        }
      }
    }
    for (const def of ex.definitions) {
      const node = index.byId.get(symbolId(ex.file, def.localId));
      if (!node) continue;
      if (def.kind === "method") {
        const receiver = receiverOf(def);
        const methods = data.methods.get(receiver) ?? new Map<string, GraphNode>();
        data.methods.set(receiver, methods);
        const methodName = methodNameOf(def);
        if (!methods.has(methodName)) methods.set(methodName, node);
      } else if (def.parentLocalId === undefined) {
        push(data.topAll, def.name, node);
        if (!isTest) push(data.topNonTest, def.name, node);
      }
    }
  }
  return data;
}

/** Groups extractions into directories and packages. `extractions` must be sorted by file. */
export function buildDirs(
  extractions: readonly FileExtraction[],
  index: SymbolIndex,
): Map<string, DirData> {
  const grouped = new Map<string, Map<string, FileExtraction[]>>();
  for (const ex of extractions) {
    const dir = dirOf(ex.file);
    const byName = grouped.get(dir) ?? new Map<string, FileExtraction[]>();
    grouped.set(dir, byName);
    const name = packageNameOf(ex);
    const list = byName.get(name) ?? [];
    byName.set(name, list);
    list.push(ex);
  }
  const dirs = new Map<string, DirData>();
  for (const dir of [...grouped.keys()].sort(compareCodeUnits)) {
    const byName = grouped.get(dir) as Map<string, FileExtraction[]>;
    const groups = [...byName.entries()]
      .sort((a, b) => compareCodeUnits(a[0], b[0]))
      .map(([name, list]) => buildPackage(dir, name, list, index));
    // Primary: the package with the most non-test files (ties: smaller name).
    let primary: PackageData | undefined;
    let best = 0;
    for (const group of groups) {
      const count = group.extractions.filter((e) => !isGoTestFile(e)).length;
      if (count > best) {
        best = count;
        primary = group;
      }
    }
    dirs.set(dir, { dir, groups, primary });
  }
  return dirs;
}
