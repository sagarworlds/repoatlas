import { addBinding, type Binding, type BindingMap, type SymbolIndex } from "@repoatlas/plugin-api";
import type { Definition, FileExtraction } from "@repoatlas/schema";
import type { ModuleTable } from "../prepare/project-info.ts";
import { analyseImport, type ImportOutcome } from "./imports.ts";

export interface FileBindings {
  /** file -> local name -> binding. */
  bindings: Map<string, BindingMap>;
  /** file -> one outcome per RawImport, in the same order as `extraction.imports`. */
  outcomes: Map<string, ImportOutcome[]>;
  /**
   * file -> localId of a function -> the names its own (function-level) imports bind.
   * These also sit in the file-wide map, but the resolver overlays them on top for
   * references inside that function, so two functions can import different things as `x`.
   */
  scoped: Map<string, Map<string, ScopedBinding[]>>;
}

export interface ScopedBinding {
  name: string;
  binding: Binding;
}

/** The innermost function or method whose lines contain `line` (an import inside it). */
function enclosingFunction(extraction: FileExtraction, line: number): Definition | undefined {
  let best: Definition | undefined;
  for (const def of extraction.definitions) {
    if (def.kind !== "function" && def.kind !== "method") continue;
    if (line <= def.span.startLine || line > def.span.endLine) continue;
    if (
      best === undefined ||
      def.span.endLine - def.span.startLine < best.span.endLine - best.span.startLine
    ) {
      best = def;
    }
  }
  return best;
}

function buildPass(
  table: ModuleTable,
  index: SymbolIndex,
  extractions: readonly FileExtraction[],
  exportedNames: Map<string, string[]>,
  direct: Map<string, BindingMap> | undefined,
): FileBindings {
  const bindings = new Map<string, BindingMap>();
  const outcomes = new Map<string, ImportOutcome[]>();
  const scoped = new Map<string, Map<string, ScopedBinding[]>>();
  for (const extraction of extractions) {
    const env =
      direct === undefined
        ? { table, index, exportedNames }
        : { table, index, exportedNames, direct };
    const map: BindingMap = new Map();
    const list: ImportOutcome[] = [];
    const moduleLevel: ImportOutcome[] = [];
    const functionLevel: ImportOutcome[] = [];
    for (const imp of extraction.imports) {
      const outcome = analyseImport(env, extraction.file, imp);
      list.push(outcome);
      const owner = enclosingFunction(extraction, imp.line);
      if (owner === undefined) {
        moduleLevel.push(outcome);
        continue;
      }
      functionLevel.push(outcome);
      const perFile = scoped.get(extraction.file) ?? new Map<string, ScopedBinding[]>();
      scoped.set(extraction.file, perFile);
      const own = perFile.get(owner.localId) ?? [];
      perFile.set(owner.localId, own);
      own.push(...outcome.bindings);
    }
    // Function-level imports go in first, so a module-level import of the same name wins
    // file-wide. Inside a function the resolver overlays that function's own imports.
    for (const outcome of [...functionLevel, ...moduleLevel]) {
      for (const b of outcome.bindings) addBinding(map, b.name, b.binding);
    }
    bindings.set(extraction.file, map);
    outcomes.set(extraction.file, list);
  }
  return { bindings, outcomes, scoped };
}

/**
 * Builds the binding map of every file in two passes.
 *
 * Pass 1 ("direct") binds names a file imports from modules, without looking inside other
 * files' imports. Pass 2 repeats the work but lets `from pkg import name` fall back to the
 * pass-1 bindings of `pkg/__init__.py`. That is exactly one level of re-export: a name
 * re-exported through two packages is not followed. Using the fixed pass-1 result also
 * means circular imports cannot loop.
 */
export function buildFileBindings(
  table: ModuleTable,
  index: SymbolIndex,
  extractions: readonly FileExtraction[],
  exportedNames: Map<string, string[]>,
): FileBindings {
  const first = buildPass(table, index, extractions, exportedNames, undefined);
  return buildPass(table, index, extractions, exportedNames, first.bindings);
}
