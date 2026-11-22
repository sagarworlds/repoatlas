import {
  addBinding,
  type Binding,
  type BindingMap,
  isTopLevelSymbol,
  type SymbolIndex,
} from "@repoatlas/plugin-api";
import { type FileExtraction, fileId } from "@repoatlas/schema";
import type { ModuleTable } from "../prepare/project-info.ts";
import { joinModule } from "./module-lookup.ts";

/** `a.b.c`: identifiers joined by dots, nothing else. */
const DOTTED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Every dotted name a file uses as a call receiver, type hint or base-class qualifier. */
function dottedNamesOf(extraction: FileExtraction): Set<string> {
  const names = new Set<string>();
  for (const ref of extraction.references) {
    if (ref.receiver !== undefined && DOTTED_NAME.test(ref.receiver)) names.add(ref.receiver);
    const hint = ref.receiverTypeHint;
    if (hint !== undefined && DOTTED_NAME.test(hint)) {
      // The hint is a type name; only its qualifier is a module chain.
      names.add(hint.slice(0, hint.lastIndexOf(".")));
    }
  }
  return names;
}

function filePathOf(binding: Binding | undefined): string | undefined {
  if (binding === undefined || !binding.nodeId.startsWith("file:")) return undefined;
  return binding.nodeId.slice("file:".length);
}

/**
 * Follows one step of a dotted chain from the module in `file`: a submodule, a top-level
 * class or function, or a name the module imports itself (one level of re-export).
 */
function nextStep(
  table: ModuleTable,
  index: SymbolIndex,
  bindings: Map<string, BindingMap>,
  file: string,
  name: string,
): Binding | undefined {
  const own = (index.byFile.get(file) ?? []).find(
    (n) =>
      isTopLevelSymbol(n) &&
      n.name === name &&
      (n.kind === "class" || n.kind === "function" || n.kind === "interface"),
  );
  if (own) return { nodeId: own.id, confidence: "inferred", via: "import" };
  const moduleName = table.fileToModule.get(file);
  if (moduleName !== undefined) {
    const sub = table.moduleToFile.get(joinModule(moduleName, name));
    if (sub !== undefined) return { nodeId: fileId(sub), confidence: "exact", via: "import" };
  }
  const reexported = bindings.get(file)?.get(name);
  if (reexported !== undefined && !reexported.nodeId.startsWith("ext:")) {
    return { nodeId: reexported.nodeId, confidence: "inferred", via: "re-export" };
  }
  return undefined;
}

/**
 * Adds bindings for dotted chains such as `requests.cookies` (after `import requests`) or
 * `pkg.models.User`, so the shared resolver can look the whole chain up like one name.
 * Every prefix that leads to a module, class or function gets its own entry. Chains that
 * start with a name bound to something other than a module are left alone.
 */
export function addChainBindings(
  table: ModuleTable,
  index: SymbolIndex,
  extractions: readonly FileExtraction[],
  bindings: Map<string, BindingMap>,
): void {
  for (const extraction of extractions) {
    addChainBindingsForFile(table, index, extraction, bindings);
  }
}

/** The same for one file (also used for the scoped overlays of function-level imports). */
export function addChainBindingsForFile(
  table: ModuleTable,
  index: SymbolIndex,
  extraction: FileExtraction,
  bindings: Map<string, BindingMap>,
): void {
  const map = bindings.get(extraction.file);
  if (map === undefined) return;
  // Computed first so that chains added for one name cannot feed another.
  const additions: { name: string; binding: Binding }[] = [];
  for (const chain of [...dottedNamesOf(extraction)].sort()) {
    const parts = chain.split(".");
    let current = filePathOf(map.get(parts[0] ?? ""));
    for (let i = 1; i < parts.length && current !== undefined; i++) {
      const step = nextStep(table, index, bindings, current, parts[i] ?? "");
      if (step === undefined) break;
      additions.push({ name: parts.slice(0, i + 1).join("."), binding: step });
      current = filePathOf(step);
    }
  }
  for (const a of additions) if (!map.has(a.name)) addBinding(map, a.name, a.binding);
}
