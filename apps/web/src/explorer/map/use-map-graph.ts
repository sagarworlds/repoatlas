// Loads the base graph for the current URL state and merges directory expansions into it.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { fetchGraph } from "../../api/client.ts";
import { queryKeys, useGraph } from "../../api/hooks.ts";
import type { GraphParams, GraphResponse } from "../../api/types.ts";
import { type BuiltGraph, buildMapGraph, mergeGraphResponses } from "./graph-model.ts";

/** Identifies one base query; expansions belong to exactly one key. */
export function baseKeyOf(p: GraphParams): string {
  return JSON.stringify([
    p.level,
    p.root,
    p.depth,
    [...p.edgeKinds].sort(),
    p.includeTests,
    p.includeExternal,
    p.minConfidence,
  ]);
}

interface Expansions {
  key: string;
  byRoot: Record<string, GraphResponse>;
}

export function useMapGraph(analysisId: string, params: GraphParams) {
  const query = useGraph(analysisId, params);
  const queryClient = useQueryClient();
  const baseKey = baseKeyOf(params);

  // Expansions are only valid for the base query they were made on. Storing the key with
  // them (instead of resetting in an effect) means a stale set is never merged into a new base.
  const [expansions, setExpansions] = useState<Expansions>({ key: baseKey, byRoot: {} });
  const [expanding, setExpanding] = useState<string | undefined>();
  const [expandError, setExpandError] = useState<string | undefined>();
  const activeExpansions = expansions.key === baseKey ? expansions.byRoot : undefined;

  const built = useMemo<BuiltGraph | undefined>(() => {
    if (!query.data) return undefined;
    let merged: GraphResponse = query.data;
    for (const extra of Object.values(activeExpansions ?? {})) {
      merged = mergeGraphResponses(merged, extra);
    }
    return buildMapGraph(merged);
  }, [query.data, activeExpansions]);

  const expand = useCallback(
    async (nodeId: string) => {
      setExpandError(undefined);
      setExpanding(nodeId);
      const sub: GraphParams = { ...params, root: nodeId, depth: 1 };
      try {
        const response = await queryClient.fetchQuery({
          queryKey: queryKeys.graph(analysisId, sub),
          queryFn: ({ signal }) => fetchGraph(analysisId, sub, signal),
          staleTime: Number.POSITIVE_INFINITY,
        });
        // Functional update: always builds on the latest state, never on a stale closure.
        setExpansions((prev) => ({
          key: baseKey,
          byRoot: { ...(prev.key === baseKey ? prev.byRoot : {}), [nodeId]: response },
        }));
      } catch (err) {
        setExpandError(err instanceof Error ? err.message : "Could not expand this folder.");
      } finally {
        setExpanding(undefined);
      }
    },
    [analysisId, baseKey, params, queryClient],
  );

  return {
    query,
    baseKey,
    built,
    expand,
    expanding,
    expandError,
    clearExpandError: () => setExpandError(undefined),
  };
}
