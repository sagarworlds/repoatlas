import type { AnalysisStats } from "@repoatlas/schema";

export interface ReportMeta {
  owner: string;
  repo: string;
  ref: string;
  commitSha: string;
}

/** Resolution-rate targets per language (docs/TESTING.md section 4). */
export const RESOLUTION_TARGETS: Record<string, number> = {
  typescript: 0.9,
  javascript: 0.9,
  go: 0.75,
  java: 0.75,
  csharp: 0.75,
  python: 0.65,
  php: 0.65,
  rust: 0.65,
  ruby: 0.5,
  cpp: 0.5,
  c: 0.5,
};
const DEFAULT_TARGET = 0.65;
const NAME_MATCH_LIMIT = 0.2;
const NAME_MATCH_EXEMPT = new Set(["ruby", "cpp", "c"]);

function pct(part: number, total: number): string {
  return total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)}%`;
}

function section(title: string, lines: string[]): string[] {
  return ["", title, ...lines.map((l) => `  ${l}`)];
}

function sortedEntries(record: Record<string, number | undefined>): [string, number][] {
  const entries: [string, number][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) entries.push([key, value]);
  }
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Quality verdict against the TESTING section 4 targets. Pure, so it is unit-tested. */
export function evaluateQuality(stats: AnalysisStats): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const languages = Object.entries(stats.languages).filter(
    (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined,
  );
  // Each language is checked against its own target when it has per-language reference
  // counts. Analyses without them (older ones) fall back to the whole-repository counts and
  // the target of the dominant language (most files).
  const withCounts = languages.filter(([, info]) => info.references !== undefined);
  if (withCounts.length > 0) {
    for (const [id, info] of withCounts) {
      const { total, resolved } = info.references ?? { total: 0, resolved: 0 };
      const target = RESOLUTION_TARGETS[id] ?? DEFAULT_TARGET;
      if (total > 0 && resolved / total < target) {
        reasons.push(
          `${id} resolution rate ${pct(resolved, total)} is below the ${Math.round(target * 100)}% target`,
        );
      }
    }
  } else {
    const dominant = [...languages].sort((a, b) => b[1].files - a[1].files)[0]?.[0];
    const target = dominant ? (RESOLUTION_TARGETS[dominant] ?? DEFAULT_TARGET) : DEFAULT_TARGET;
    const { total, resolved } = stats.references;
    if (total > 0 && resolved / total < target) {
      reasons.push(
        `resolution rate ${pct(resolved, total)} is below the ${Math.round(target * 100)}% target for ${dominant ?? "unknown"}`,
      );
    }
  }
  const allExempt = languages.length > 0 && languages.every(([id]) => NAME_MATCH_EXEMPT.has(id));
  const edgeTotal =
    (stats.edgesByConfidence.exact ?? 0) +
    (stats.edgesByConfidence.inferred ?? 0) +
    (stats.edgesByConfidence["name-match"] ?? 0);
  const nameMatch = stats.edgesByConfidence["name-match"] ?? 0;
  if (!allExempt && edgeTotal > 0 && nameMatch / edgeTotal > NAME_MATCH_LIMIT) {
    reasons.push(`name-match edges are ${pct(nameMatch, edgeTotal)} (limit 20%)`);
  }
  if (stats.droppedInvalidEdges > 0) {
    reasons.push(`${stats.droppedInvalidEdges} invalid edges were dropped (likely an ID bug)`);
  }
  if (stats.pluginErrors.length > 0) {
    reasons.push(`${stats.pluginErrors.length} plugin error(s)`);
  }
  if (stats.truncated) reasons.push("graph was truncated at the node or edge cap");
  return { ok: reasons.length === 0, reasons };
}

/** One line per language: its resolution rate and PASS/WARN against its target. */
function perLanguageLines(stats: AnalysisStats): string[] {
  const lines: string[] = [];
  for (const [id, info] of Object.entries(stats.languages)) {
    if (info?.references === undefined) continue;
    const { total, resolved } = info.references;
    const target = RESOLUTION_TARGETS[id] ?? DEFAULT_TARGET;
    const verdict = total === 0 || resolved / total >= target ? "PASS" : "WARN";
    lines.push(
      `${id}: ${resolved} / ${total} (${pct(resolved, total)}), target ${Math.round(target * 100)}% ${verdict}`,
    );
  }
  return lines.sort();
}

/** Name-match share of edges against the 20% limit (PASS/WARN). */
function nameMatchLine(stats: AnalysisStats, edgeTotal: number): string {
  const nameMatch = stats.edgesByConfidence["name-match"] ?? 0;
  const verdict = edgeTotal === 0 || nameMatch / edgeTotal <= NAME_MATCH_LIMIT ? "PASS" : "WARN";
  return `name-match share of edges: ${pct(nameMatch, edgeTotal)}, limit 20% ${verdict}`;
}

/** Formats the human-readable report printed by the CLI. */
export function formatStats(stats: AnalysisStats, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`${meta.owner}/${meta.repo}@${meta.commitSha.slice(0, 12)} (ref: ${meta.ref})`);
  lines.push(`analyzer v${stats.analyzerVersion}, schema v${stats.schemaVersion}`);

  const languageLines = Object.entries(stats.languages)
    .flatMap(([id, info]) => (info ? [[id, info] as const] : []))
    .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
    .map(
      ([id, info]) => `${id}: ${info.files} files, ${info.bytes} bytes, tier ${info.pluginTier}`,
    );
  lines.push(...section("Languages", languageLines.length > 0 ? languageLines : ["(none)"]));

  lines.push(
    ...section(
      "Nodes by kind",
      sortedEntries(stats.nodesByKind).map(([k, n]) => `${k}: ${n}`),
    ),
  );
  lines.push(
    ...section(
      "Edges by kind",
      sortedEntries(stats.edgesByKind).map(([k, n]) => `${k}: ${n}`),
    ),
  );

  const edgeTotal = Object.values(stats.edgesByConfidence).reduce((a, b) => a + b, 0);
  lines.push(
    ...section(
      "Edges by confidence",
      (["exact", "inferred", "name-match"] as const).map((c) => {
        const n = stats.edgesByConfidence[c] ?? 0;
        return `${c}: ${n} (${pct(n, edgeTotal)})`;
      }),
    ),
  );

  const refs = stats.references;
  lines.push(
    ...section("References", [
      `resolved: ${refs.resolved} / ${refs.total} (${pct(refs.resolved, refs.total)})`,
      `unresolved: ${refs.unresolved}`,
      ...perLanguageLines(stats),
      nameMatchLine(stats, edgeTotal),
    ]),
  );

  lines.push(
    ...section(
      "Skipped files",
      stats.skippedFiles.length > 0
        ? [...stats.skippedFiles]
            .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
            .map((s) => `${s.reason}: ${s.count}`)
        : ["(none)"],
    ),
  );

  lines.push(
    ...section("Problems", [
      `files with parse errors: ${stats.parseErrorFiles}`,
      `dropped invalid edges: ${stats.droppedInvalidEdges}`,
      `plugin errors: ${stats.pluginErrors.length}`,
      ...stats.pluginErrors.map((e) => `  ${e.plugin} [${e.stage}]: ${e.message}`),
    ]),
  );

  lines.push(
    ...section(
      "Timings (ms)",
      Object.entries(stats.timingsMs).map(([k, v]) => `${k}: ${Math.round(v)}`),
    ),
  );

  if (stats.cache) {
    lines.push(
      ...section("Extraction cache", [`hits: ${stats.cache.hits}, misses: ${stats.cache.misses}`]),
    );
  }

  const verdict = evaluateQuality(stats);
  lines.push("");
  lines.push(
    verdict.ok ? "PASS: meets the quality targets" : `WARN: ${verdict.reasons.join("; ")}`,
  );
  return `${lines.join("\n")}\n`;
}
