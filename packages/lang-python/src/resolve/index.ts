import type { BindingMap, ResolveInput } from "@repoatlas/plugin-api";
import {
  applySuperTypes,
  type ResolutionSummary,
  type ResolveContext,
  type ResolvedRef,
  resolveReference,
  summariseResolution,
  toEdges,
  toUnresolved,
} from "@repoatlas/plugin-api";
import type {
  Definition,
  FileExtraction,
  GraphEdge,
  RawReference,
  ResolutionResult,
  Unresolved,
} from "@repoatlas/schema";
import { readProjectInfo, tableFromPaths } from "../prepare/project-info.ts";
import { buildFileBindings, type ScopedBinding } from "./bindings.ts";
import { addChainBindings, addChainBindingsForFile } from "./chains.ts";
import { parseDunderAll } from "./dunder-all.ts";
import { fixtureReceiverHint } from "./fixtures.ts";
import { buildImportEdges } from "./import-edges.ts";
import { wildcardTargetFile } from "./imports.ts";
import { isBuiltinNoise, PYTHON_STOPLIST } from "./stoplist.ts";

export { parseDunderAll } from "./dunder-all.ts";
export { isBuiltinNoise, PYTHON_STOPLIST } from "./stoplist.ts";

/** `a.b.c`: identifiers joined by dots, nothing else (no calls, subscripts or spaces). */
const DOTTED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const SELF_NAMES = new Set(["self", "cls"]);

/** Called once per reference with its outcome; `undefined` means a call through a parameter. */
export type ReferenceObserver = (
  extraction: FileExtraction,
  ref: RawReference,
  resolved: ResolvedRef | undefined,
) => void;

export interface PythonResolution {
  result: ResolutionResult;
  /** Counts of resolved and unresolved references, with the unresolved ones by reason. */
  summary: ResolutionSummary;
}

function compareFiles(a: FileExtraction, b: FileExtraction): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/**
 * The shared resolver treats only plain identifiers as module or class receivers. In Python
 * `m.User.create()` has the receiver `m.User` (a dotted chain), which the extractor may
 * label "member-chain". When it is made of identifiers only, and does not start with
 * self/cls, hand it to the resolver as an identifier: it then walks module aliases and
 * class names through the file's bindings.
 */
function normaliseReference(ref: RawReference): RawReference {
  const { receiver, receiverKind } = ref;
  if (receiver === undefined || !DOTTED_NAME.test(receiver)) return ref;
  if (receiverKind !== undefined && receiverKind !== "member-chain") return ref;
  const first = receiver.slice(0, receiver.indexOf("."));
  if (SELF_NAMES.has(first)) return ref;
  return { ...ref, receiverKind: "identifier" };
}

/**
 * A bare call `callback(x)` where `callback` is a parameter of the enclosing function (or of
 * a function around it). The callee is a runtime value, so there is nothing to resolve and
 * matching the name against unrelated functions would only create false edges.
 */
function callsParameter(byId: ReadonlyMap<string, Definition>, ref: RawReference): boolean {
  if (ref.kind !== "call" || ref.receiver !== undefined || ref.receiverKind !== undefined) {
    return false;
  }
  let current = ref.fromLocalId === undefined ? undefined : byId.get(ref.fromLocalId);
  while (current !== undefined) {
    const params = current.meta?.["py.params"];
    if (Array.isArray(params) && params.includes(ref.name)) return true;
    current = current.parentLocalId === undefined ? undefined : byId.get(current.parentLocalId);
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Literal `__all__` of every file that some wildcard import targets. The extractor may
 * provide it as `meta["py.all"]`; otherwise the source is read through the repo view and
 * scanned (nothing is executed).
 */
async function loadExportedNames(
  input: ResolveInput,
  extractions: readonly FileExtraction[],
  table: ReturnType<typeof tableFromPaths>,
): Promise<Map<string, string[]>> {
  const byFile = new Map(extractions.map((e) => [e.file, e]));
  const targets = new Set<string>();
  for (const extraction of extractions) {
    for (const imp of extraction.imports) {
      const target = wildcardTargetFile(table, extraction.file, imp);
      if (target !== undefined) targets.add(target);
    }
  }
  const result = new Map<string, string[]>();
  for (const file of [...targets].sort()) {
    const fromMeta = byFile.get(file)?.meta?.["py.all"];
    if (isStringArray(fromMeta)) {
      result.set(file, fromMeta);
      continue;
    }
    try {
      const source = await input.repo.read(file);
      const names = source === undefined ? undefined : parseDunderAll(source);
      if (names !== undefined) result.set(file, names);
    } catch {
      // An unreadable file simply has no literal __all__.
    }
  }
  return result;
}

/**
 * The context to resolve a reference with. When the function around the reference (or one of
 * its outer functions) has imports of its own, those shadow the file-wide bindings; the
 * overlay is built once per (file, function) and reused.
 */
function makeScopedContext(
  base: ResolveContext,
  table: ReturnType<typeof tableFromPaths>,
  scoped: ReadonlyMap<string, ReadonlyMap<string, readonly ScopedBinding[]>>,
): (extraction: FileExtraction, ref: RawReference) => ResolveContext {
  const cache = new Map<string, ResolveContext>();
  return (extraction, ref) => {
    const perFile = scoped.get(extraction.file);
    if (perFile === undefined || ref.fromLocalId === undefined) return base;
    const key = `${extraction.file}\0${ref.fromLocalId}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const byId = new Map(extraction.definitions.map((d) => [d.localId, d]));
    const chain: ScopedBinding[][] = [];
    for (
      let current = byId.get(ref.fromLocalId);
      current !== undefined;
      current = current.parentLocalId === undefined ? undefined : byId.get(current.parentLocalId)
    ) {
      const own = perFile.get(current.localId);
      if (own !== undefined) chain.unshift([...own]); // outermost first, innermost wins
    }
    let result = base;
    if (chain.length > 0) {
      const fileMap: BindingMap = new Map(base.bindings.get(extraction.file));
      const overridden = new Set(chain.flat().map((b) => b.name));
      for (const name of [...fileMap.keys()]) {
        // Drop dotted chains (`a.b`) that hang off a name that is rebound here.
        if (name.includes(".") && overridden.has(name.slice(0, name.indexOf(".")))) {
          fileMap.delete(name);
        }
      }
      for (const group of chain) for (const b of group) fileMap.set(b.name, b.binding);
      const bindings = new Map(base.bindings).set(extraction.file, fileMap);
      addChainBindingsForFile(table, base.index, extraction, bindings);
      result = { ...base, bindings };
    }
    cache.set(key, result);
    return result;
  };
}

/** Like `pythonResolve`, but also returns the resolution summary (used by tests and stats). */
export async function resolvePythonDetailed(
  input: ResolveInput,
  observer?: ReferenceObserver,
): Promise<PythonResolution> {
  const extractions = [...input.extractions].sort(compareFiles);
  const table = readProjectInfo(input.info) ?? tableFromPaths(extractions.map((e) => e.file));

  const exportedNames = await loadExportedNames(input, extractions, table);
  const { bindings, outcomes, scoped } = buildFileBindings(
    table,
    input.index,
    extractions,
    exportedNames,
  );
  addChainBindings(table, input.index, extractions, bindings);

  const ctx: ResolveContext = {
    index: input.index,
    bindings,
    language: "python",
    constructorNames: ["__init__"],
    stoplistExtra: PYTHON_STOPLIST,
    // No sameScopeLookup: Python has no implicit package scope, only the file and its imports.
  };

  // Inheritance first: `self.x()` lookups walk the recorded super types.
  applySuperTypes(ctx, extractions);
  const contextFor = makeScopedContext(ctx, table, scoped);

  const extractionsByFile = new Map(extractions.map((e) => [e.file, e]));
  const edges: GraphEdge[] = [];
  const unresolved: Unresolved[] = [];
  const results: ResolvedRef[] = [];

  for (const extraction of extractions) {
    const list = outcomes.get(extraction.file) ?? [];
    extraction.imports.forEach((imp, i) => {
      if (list[i]?.unresolved === true) {
        unresolved.push({
          file: extraction.file,
          line: imp.line,
          name: imp.specifier,
          kind: "import",
        });
      }
    });

    const definitionsById = new Map(extraction.definitions.map((d) => [d.localId, d]));
    for (const raw of extraction.references) {
      if (callsParameter(definitionsById, raw)) {
        observer?.(extraction, raw, undefined);
        continue;
      }
      const ref = normaliseReference(raw);
      const fixture = fixtureReceiverHint(extractionsByFile, extraction, definitionsById, ref);
      const resolved =
        fixture === undefined
          ? resolveReference(contextFor(extraction, ref), extraction, ref)
          : resolveReference(ctx, fixture.extraction, {
              ...ref,
              receiver: undefined,
              receiverKind: "other",
              receiverTypeHint: fixture.hint,
            });
      results.push(resolved);
      observer?.(extraction, ref, resolved);
      edges.push(...toEdges(extraction, ref, resolved));
      const missed = resolved.targets.length === 0 && resolved.unresolved === true;
      if (missed && resolved.reason !== "external") {
        const hasReceiver = ref.receiver !== undefined || ref.receiverKind !== undefined;
        if (!isBuiltinNoise(ref.name, hasReceiver)) unresolved.push(toUnresolved(extraction, ref));
      }
    }
  }

  const { imports, externals } = buildImportEdges(extractions, outcomes);
  return {
    result: { imports, edges, externals, unresolved },
    summary: summariseResolution(results),
  };
}

/**
 * Plugin `resolve` step. `input.info` is the `PythonProjectInfo` from `pythonPrepare`
 * (when it is missing or malformed, roots are inferred from the extracted file paths).
 */
export async function pythonResolve(input: ResolveInput): Promise<ResolutionResult> {
  return (await resolvePythonDetailed(input)).result;
}
