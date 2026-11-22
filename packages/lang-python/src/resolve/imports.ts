import {
  type Binding,
  type BindingMap,
  isTopLevelSymbol,
  type SymbolIndex,
} from "@repoatlas/plugin-api";
import type { Confidence, GraphNode, RawImport } from "@repoatlas/schema";
import { externalId, fileId } from "@repoatlas/schema";
import type { ModuleTable } from "../prepare/project-info.ts";
import { isStdlibModule } from "../prepare/stdlib.ts";
import {
  absoluteModuleName,
  findModule,
  joinModule,
  type ModuleName,
  topLevelOf,
} from "./module-lookup.ts";

/** One file-level import edge that a RawImport produces (before merging duplicates). */
export interface ImportTarget {
  dst: string;
  confidence: Confidence;
  names: string[];
  alias?: string;
  dynamic: boolean;
  /** For stdlib targets: the module that was imported (`os.path`). */
  stdlibModule?: string;
  /** True when every imported name arrived through a re-export. */
  reexport: boolean;
}

export interface ImportOutcome {
  bindings: { name: string; binding: Binding }[];
  targets: ImportTarget[];
  /** The import names something internal that does not exist (or goes beyond the root). */
  unresolved: boolean;
}

export interface ImportEnv {
  table: ModuleTable;
  index: SymbolIndex;
  /**
   * Bindings of every file computed without re-export following. Present in the second pass;
   * it lets `from pkg import name` look into `pkg/__init__.py` (exactly one level).
   */
  direct?: Map<string, BindingMap>;
  /** Literal `__all__` of wildcard targets (file -> names). Absent key = no literal list. */
  exportedNames: Map<string, string[]>;
}

const NOTHING: ImportOutcome = { bindings: [], targets: [], unresolved: false };

export function externalFor(moduleName: string): { id: string; name: string; stdlib: boolean } {
  const top = topLevelOf(moduleName);
  if (isStdlibModule(top))
    return { id: externalId("pypi", "stdlib"), name: "stdlib", stdlib: true };
  return { id: externalId("pypi", top), name: top, stdlib: false };
}

function binding(nodeId: string, confidence: Confidence, via: Binding["via"]): Binding {
  return { nodeId, confidence, via };
}

/** A top-level class/function of `file` called `name`. */
function ownSymbol(
  index: SymbolIndex,
  file: string | undefined,
  name: string,
): GraphNode | undefined {
  if (file === undefined) return undefined;
  return (index.byFile.get(file) ?? []).find(
    (n) =>
      isTopLevelSymbol(n) &&
      n.name === name &&
      (n.kind === "class" || n.kind === "function" || n.kind === "interface"),
  );
}

function unresolvedOutcome(): ImportOutcome {
  return { bindings: [], targets: [], unresolved: true };
}

function externalOutcome(
  names: { name: string; binding: Binding }[],
  moduleName: string,
  extra: { names?: string[]; alias?: string; dynamic?: boolean },
): ImportOutcome {
  const ext = externalFor(moduleName);
  const target: ImportTarget = {
    dst: ext.id,
    confidence: "exact",
    names: extra.names ?? [],
    dynamic: extra.dynamic === true,
    reexport: false,
  };
  if (extra.alias !== undefined) target.alias = extra.alias;
  if (ext.stdlib) target.stdlibModule = moduleName;
  return { bindings: names, targets: [target], unresolved: false };
}

/**
 * True when the import leaves the repository. A directory without `__init__.py` that has
 * the name of a standard library module (for example `tests/typing/`) is only a namespace
 * package: Python prefers a real module, so `import typing` still means the stdlib. An
 * import of a module that really exists below such a directory stays internal.
 */
function isExternalName(table: ModuleTable, moduleName: string): boolean {
  if (moduleName === "") return false; // the repo root, reached by `from . import x`
  const top = topLevelOf(moduleName);
  if (!table.internalTopLevel.has(top)) return true;
  return (
    isStdlibModule(top) &&
    table.moduleToFile.get(top) === undefined &&
    table.moduleToFile.get(moduleName) === undefined
  );
}

/** `import a.b.c` and `import a.b.c as x` (also used for side-effect and dynamic imports). */
function analyseModuleImport(env: ImportEnv, name: string, imp: RawImport): ImportOutcome {
  const { table } = env;
  const dynamic = imp.kind === "dynamic";
  const binds = imp.kind === "module";
  const top = topLevelOf(name);

  if (isExternalName(table, name)) {
    const local = imp.alias ?? top;
    const ext = externalFor(name);
    const bindings = binds ? [{ name: local, binding: binding(ext.id, "exact", "import") }] : [];
    const extra: { alias?: string; dynamic: boolean } = { dynamic };
    if (imp.alias !== undefined) extra.alias = imp.alias;
    return externalOutcome(bindings, name, extra);
  }

  const lookup = findModule(env.table, name);
  if (!lookup.known) return unresolvedOutcome();

  const bindings: { name: string; binding: Binding }[] = [];
  if (binds && imp.alias !== undefined) {
    if (lookup.file !== undefined) {
      bindings.push({
        name: imp.alias,
        binding: binding(fileId(lookup.file), "exact", "import"),
      });
    }
  } else if (binds) {
    // `import a.b.c` binds `a`, and the dotted chains `a.b`, `a.b.c` for attribute access.
    const parts = name.split(".");
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join(".");
      const file = findModule(table, prefix).file;
      if (file !== undefined) {
        bindings.push({ name: prefix, binding: binding(fileId(file), "exact", "import") });
      }
    }
  }

  if (lookup.file === undefined) return { bindings, targets: [], unresolved: false };
  const target: ImportTarget = {
    dst: fileId(lookup.file),
    confidence: dynamic ? "inferred" : "exact",
    names: [],
    dynamic,
    reexport: false,
  };
  if (imp.alias !== undefined) target.alias = imp.alias;
  return { bindings, targets: [target], unresolved: false };
}

/** Binds one imported name of an internal module. Returns how it was found. */
function bindImportedName(
  env: ImportEnv,
  moduleName: string,
  targetFile: string | undefined,
  name: string,
  local: string,
  via: "import" | "wildcard",
  out: { name: string; binding: Binding }[],
  extraTargets: ImportTarget[],
): "symbol" | "submodule" | "reexport" | "none" {
  const sym = ownSymbol(env.index, targetFile, name);
  if (sym) {
    out.push({ name: local, binding: binding(sym.id, "inferred", via) });
    return "symbol";
  }
  const sub = findModule(env.table, joinModule(moduleName, name));
  if (sub.file !== undefined) {
    out.push({ name: local, binding: binding(fileId(sub.file), "exact", via) });
    extraTargets.push({
      dst: fileId(sub.file),
      confidence: via === "wildcard" ? "inferred" : "exact",
      names: [name],
      dynamic: false,
      reexport: false,
    });
    return "submodule";
  }
  const reexported = targetFile === undefined ? undefined : env.direct?.get(targetFile)?.get(name);
  if (reexported) {
    out.push({
      name: local,
      binding: binding(
        reexported.nodeId,
        "inferred",
        via === "wildcard" ? "wildcard" : "re-export",
      ),
    });
    return "reexport";
  }
  return "none";
}

function analyseNamedImport(env: ImportEnv, moduleName: string, imp: RawImport): ImportOutcome {
  const names = imp.names ?? [];
  if (isExternalName(env.table, moduleName)) {
    const ext = externalFor(moduleName);
    const bindings = names.map((n) => ({
      name: n.alias ?? n.name,
      binding: binding(ext.id, "exact", "import"),
    }));
    return externalOutcome(bindings, moduleName, { names: names.map((n) => n.name).sort() });
  }
  const lookup = findModule(env.table, moduleName);
  if (!lookup.known) return unresolvedOutcome();

  const bindings: { name: string; binding: Binding }[] = [];
  const extraTargets: ImportTarget[] = [];
  let reexports = 0;
  for (const item of names) {
    const how = bindImportedName(
      env,
      moduleName,
      lookup.file,
      item.name,
      item.alias ?? item.name,
      "import",
      bindings,
      extraTargets,
    );
    if (how === "reexport") reexports++;
  }
  const targets: ImportTarget[] = [];
  if (lookup.file !== undefined) {
    targets.push({
      dst: fileId(lookup.file),
      // Names that only exist through a re-export make the edge a weaker statement.
      confidence: names.length > 0 && reexports === names.length ? "inferred" : "exact",
      names: names.map((n) => n.name).sort(),
      dynamic: false,
      reexport: names.length > 0 && reexports === names.length,
    });
  }
  targets.push(...extraTargets);
  return { bindings, targets, unresolved: false };
}

/** Names that `from module import *` brings in: the literal `__all__`, else public names. */
function wildcardNames(env: ImportEnv, targetFile: string): string[] {
  const listed = env.exportedNames.get(targetFile);
  if (listed) return listed;
  const own = (env.index.byFile.get(targetFile) ?? []).filter(isTopLevelSymbol).map((n) => n.name);
  const imported = [...(env.direct?.get(targetFile)?.keys() ?? [])];
  return [...new Set([...own, ...imported])].filter((n) => !n.startsWith("_")).sort();
}

function analyseWildcardImport(env: ImportEnv, moduleName: string): ImportOutcome {
  if (isExternalName(env.table, moduleName)) {
    return externalOutcome([], moduleName, { names: ["*"] });
  }
  const lookup = findModule(env.table, moduleName);
  if (!lookup.known) return unresolvedOutcome();
  if (lookup.file === undefined) return NOTHING;

  const bindings: { name: string; binding: Binding }[] = [];
  const extraTargets: ImportTarget[] = [];
  for (const name of wildcardNames(env, lookup.file)) {
    bindImportedName(env, moduleName, lookup.file, name, name, "wildcard", bindings, extraTargets);
  }
  const targets: ImportTarget[] = [
    {
      dst: fileId(lookup.file),
      confidence: "inferred",
      names: ["*"],
      dynamic: false,
      reexport: false,
    },
    ...extraTargets,
  ];
  return { bindings, targets, unresolved: false };
}

/**
 * Resolves one import statement of `file`: the names it binds and the file-level edges it
 * produces. Pure. `__future__` imports produce nothing.
 */
export function analyseImport(env: ImportEnv, file: string, imp: RawImport): ImportOutcome {
  const module: ModuleName = absoluteModuleName(env.table, file, imp);
  if (!module.ok) return unresolvedOutcome();
  const { name } = module;
  if (!module.relative && topLevelOf(name) === "__future__") return NOTHING;
  if (name === "" && !module.relative) return NOTHING;

  if (imp.kind === "wildcard") return analyseWildcardImport(env, name);
  if (imp.kind === "named") return analyseNamedImport(env, name, imp);
  return analyseModuleImport(env, name, imp);
}

/** The module name a wildcard import points at, used to find `__all__` before binding. */
export function wildcardTargetFile(
  table: ModuleTable,
  file: string,
  imp: RawImport,
): string | undefined {
  if (imp.kind !== "wildcard") return undefined;
  const module = absoluteModuleName(table, file, imp);
  return module.ok ? findModule(table, module.name).file : undefined;
}
