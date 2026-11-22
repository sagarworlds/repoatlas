import type { FileExtraction, GraphNode, RawReference } from "@repoatlas/schema";
import { symbolId } from "@repoatlas/schema";
import { isTypeNode, resolveTypeName } from "./type-name.ts";
import type { ResolveContext, ResolvedRef } from "./types.ts";

export type InheritanceResolver = (
  ctx: ResolveContext,
  extraction: FileExtraction,
  ref: RawReference,
) => ResolvedRef;

const defaultInheritanceResolver: InheritanceResolver = (ctx, extraction, ref) =>
  resolveTypeName(ctx, extraction, ref.name, ref.receiver);

/**
 * Pass 1 of resolution: resolves every extends/implements reference and records the
 * result as a super type, so that `self.x()` lookups can walk the hierarchy.
 * Name-match results are not recorded (a wrong base class would poison every lookup).
 * Super types go to `ctx.superTypes` and, when the index supports it, `index.addSuperType`.
 * Returns the number of (sub, super) pairs recorded. Order follows the input order.
 */
export function applySuperTypes(
  ctx: ResolveContext,
  extractions: readonly FileExtraction[],
  resolveFn: InheritanceResolver = defaultInheritanceResolver,
): number {
  const overlay = ctx.superTypes ?? new Map<string, string[]>();
  ctx.superTypes = overlay;
  let recorded = 0;
  for (const extraction of extractions) {
    for (const ref of extraction.references) {
      if (ref.kind !== "extends" && ref.kind !== "implements") continue;
      if (ref.fromLocalId === undefined) continue;
      const subId = symbolId(extraction.file, ref.fromLocalId);
      const resolved = resolveFn(ctx, extraction, ref);
      for (const target of resolved.targets) {
        if (target.confidence === "name-match" || target.nodeId === subId) continue;
        const node: GraphNode | undefined = ctx.index.byId.get(target.nodeId);
        if (!node || !isTypeNode(node)) continue;
        const list = overlay.get(subId);
        if (!list) overlay.set(subId, [target.nodeId]);
        else if (!list.includes(target.nodeId)) list.push(target.nodeId);
        else continue;
        ctx.index.addSuperType?.(subId, target.nodeId);
        recorded++;
      }
    }
  }
  return recorded;
}
