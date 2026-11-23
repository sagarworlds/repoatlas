import type { ResolveContext, ResolvedRef, ResolveInput } from "@repoatlas/plugin-api";
import {
  applySuperTypes,
  isStoplisted,
  type ResolutionSummary,
  summariseResolution,
  toEdges,
  toUnresolved,
} from "@repoatlas/plugin-api";
import type {
  FileExtraction,
  GraphEdge,
  RawReference,
  ResolutionResult,
  Unresolved,
} from "@repoatlas/schema";
import { symbolId } from "@repoatlas/schema";
import { readJavaProjectInfo } from "../prepare/index.ts";
import { assignCallFacts, localTypesOf } from "./call-args.ts";
import { buildImportEdges } from "./import-edges.ts";
import { JAVA_STOPLIST, OBJECT_METHODS } from "./java-names.ts";
import { buildJavaModel, classChain } from "./model.ts";
import {
  looksLikeTypeVariable,
  type RefEnv,
  resolveJavaReference,
  typeText,
  typeToResolved,
} from "./references.ts";
import { buildFileScope, type FileScope, lookupTypeName, type ResolveState } from "./scope.ts";
import { compareText } from "./text.ts";

export { externalKeyFor, JAVA_LANG_TYPES, JAVA_STOPLIST } from "./java-names.ts";
export type { ClassInfo, JavaModel, MethodInfo } from "./model.ts";
export { buildJavaModel } from "./model.ts";

/** Called once per reference with its outcome. */
export type ReferenceObserver = (
  extraction: FileExtraction,
  ref: RawReference,
  resolved: ResolvedRef,
) => void;

export interface JavaResolution {
  result: ResolutionResult;
  /** Counts of resolved and unresolved references, with the unresolved ones by reason. */
  summary: ResolutionSummary;
}

function compareFiles(a: FileExtraction, b: FileExtraction): number {
  return compareText(a.file, b.file);
}

/**
 * Pass 1: records every extends/implements as a super type (via plugin-api's
 * `applySuperTypes`, which also feeds the index when it accepts super types). Run twice so
 * that a super type named through an inherited member type is found on the second pass.
 * Then marks classes whose super types are outside the repository ("opaque").
 */
function resolveSuperTypes(state: ResolveState, extractions: readonly FileExtraction[]): void {
  const ctx: ResolveContext = { index: state.index, bindings: new Map(), language: "java" };
  const resolveFn = (
    _ctx: ResolveContext,
    extraction: FileExtraction,
    ref: RawReference,
  ): ResolvedRef => {
    const scope = state.scopes.get(extraction.file);
    if (scope === undefined) return { targets: [], unresolved: true, reason: "no-candidate" };
    const chain = classChain(state.model, extraction, ref.fromLocalId, false);
    return typeToResolved(lookupTypeName(state, scope, chain, typeText(ref)), scope, ref.name);
  };
  for (let pass = 0; pass < 2; pass++) {
    applySuperTypes(ctx, extractions, resolveFn);
    state.superTypes = ctx.superTypes ?? new Map();
  }
  for (const extraction of extractions) {
    const scope = state.scopes.get(extraction.file);
    if (scope === undefined) continue;
    for (const ref of extraction.references) {
      if ((ref.kind !== "extends" && ref.kind !== "implements") || ref.fromLocalId === undefined)
        continue;
      const cls = state.model.byId.get(symbolId(extraction.file, ref.fromLocalId));
      if (cls === undefined) continue;
      const chain = classChain(state.model, extraction, ref.fromLocalId, false);
      const type = lookupTypeName(state, scope, chain, typeText(ref));
      if (type.kind !== "class") cls.opaqueSupers = true;
    }
  }
}

/** Misses that are neither resolved nor worth reporting: stoplisted names on unknown receivers. */
function isNoise(ref: RawReference, resolved: ResolvedRef): boolean {
  const hasReceiver = ref.receiver !== undefined || ref.receiverKind !== undefined;
  if (ref.kind === "call") {
    if (OBJECT_METHODS.has(ref.name)) return true;
    return hasReceiver && (JAVA_STOPLIST.has(ref.name) || isStoplisted(ref.name));
  }
  return resolved.reason === "no-candidate" && looksLikeTypeVariable(ref.name);
}

/** Like `javaResolve`, but also returns the resolution summary (used by tests and stats). */
export async function resolveJavaDetailed(
  input: ResolveInput,
  observer?: ReferenceObserver,
): Promise<JavaResolution> {
  const extractions = [...input.extractions].sort(compareFiles);
  const model = buildJavaModel(extractions);
  const info = readJavaProjectInfo(input.info);
  const state: ResolveState = {
    model,
    index: input.index,
    dependencyGroups: info.dependencyGroups,
    superTypes: new Map(),
    packageNames: [...model.packages.keys()].sort(compareText),
    scopes: new Map(),
  };
  for (const extraction of extractions) {
    state.scopes.set(extraction.file, buildFileScope(state, extraction));
  }
  resolveSuperTypes(state, extractions);

  const edges: GraphEdge[] = [];
  const unresolved: Unresolved[] = [];
  const results: ResolvedRef[] = [];
  const scopes: FileScope[] = [];

  for (const extraction of extractions) {
    const scope = state.scopes.get(extraction.file);
    if (scope === undefined) continue;
    scopes.push(scope);
    for (const outcome of scope.outcomes) {
      if (outcome.target.kind === "unresolved") {
        unresolved.push({
          file: extraction.file,
          line: outcome.line,
          name: outcome.specifier,
          kind: "import",
        });
      }
    }
    const facts = assignCallFacts(extraction);
    const env: RefEnv = {
      state,
      extraction,
      scope,
      args: facts.args,
      anonSupers: facts.anonSupers,
      localTypes: localTypesOf(extraction),
    };
    for (const ref of extraction.references) {
      let resolved: ResolvedRef;
      try {
        resolved = resolveJavaReference(env, ref);
      } catch {
        // One odd reference must not fail the file.
        resolved = { targets: [], unresolved: true, reason: "no-candidate" };
      }
      results.push(resolved);
      observer?.(extraction, ref, resolved);
      edges.push(...toEdges(extraction, ref, resolved));
      const missed = resolved.targets.length === 0 && resolved.unresolved === true;
      if (missed && resolved.reason !== "external" && !isNoise(ref, resolved)) {
        unresolved.push(toUnresolved(extraction, ref));
      }
    }
  }

  const { imports, externals } = buildImportEdges(scopes);
  return {
    result: { imports, edges, externals, unresolved },
    summary: summariseResolution(results),
  };
}

/**
 * Plugin `resolve` step. `input.info` is the `JavaProjectInfo` from `javaPrepare` (dependency
 * groupIds only; when it is missing the first-two-segments rule names externals).
 */
export async function javaResolve(input: ResolveInput): Promise<ResolutionResult> {
  return (await resolveJavaDetailed(input)).result;
}
