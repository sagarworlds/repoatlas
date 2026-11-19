import type { AnalysisStats } from "@repoatlas/schema";
import { compareCodeUnits, errorMessage } from "./util.ts";

/** Collects everything that goes wrong without stopping the run (skips, plugin errors). */
export interface Diagnostics {
  readonly pluginErrors: AnalysisStats["pluginErrors"];
  addSkip(reason: string, count?: number): void;
  addPluginError(plugin: string, stage: string, err: unknown): void;
  /** Skip counts merged with `others`, summed per reason and sorted by reason. */
  skippedFiles(...others: { reason: string; count: number }[][]): AnalysisStats["skippedFiles"];
}

export function createDiagnostics(): Diagnostics {
  const skips = new Map<string, number>();
  const pluginErrors: AnalysisStats["pluginErrors"] = [];
  return {
    pluginErrors,
    addSkip(reason, count = 1) {
      skips.set(reason, (skips.get(reason) ?? 0) + count);
    },
    addPluginError(plugin, stage, err) {
      pluginErrors.push({ plugin, stage, message: errorMessage(err) });
    },
    skippedFiles(...others) {
      const total = new Map(skips);
      for (const list of others) {
        for (const { reason, count } of list) total.set(reason, (total.get(reason) ?? 0) + count);
      }
      return [...total.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => compareCodeUnits(a.reason, b.reason));
    },
  };
}
