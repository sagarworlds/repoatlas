import type { AnalysisStats } from "../../api/types.ts";
import { languageName, tierHint } from "../../config/languages.ts";
import { formatPercent } from "../panels/detail-model.ts";

export interface LanguageSummary {
  id: string;
  name: string;
  files: number;
  tier: 1 | 2 | 3;
  /** Share of call references resolved (0-1); undefined for old analyses or no calls. */
  rate: number | undefined;
}

/** One summary per language present in the stats, most files first. Pure. */
export function summarizeLanguages(stats: AnalysisStats | null): LanguageSummary[] {
  if (!stats) return [];
  const result: LanguageSummary[] = [];
  for (const [id, info] of Object.entries(stats.languages)) {
    if (!info) continue;
    const refs = info.references;
    result.push({
      id,
      name: languageName(id),
      files: info.files,
      tier: info.pluginTier,
      rate: refs && refs.total > 0 ? refs.resolved / refs.total : undefined,
    });
  }
  return result.sort((a, b) => b.files - a.files || a.id.localeCompare(b.id));
}

/**
 * Chips for the languages actually present: name, file count, tier and resolution rate.
 * The numbers are visible text and the tooltip explains the tier, so colour is never the signal.
 */
export function AnalysisLanguageChips(props: { stats: AnalysisStats | null }) {
  const languages = summarizeLanguages(props.stats);
  if (languages.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Languages in this repository">
      {languages.map((lang) => (
        <li
          key={lang.id}
          title={tierHint(lang.tier)}
          className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs"
        >
          <span className="font-medium">{lang.name}</span>
          <span className="text-muted">
            {" "}
            · {lang.files} {lang.files === 1 ? "file" : "files"} · Tier {lang.tier}
            {lang.rate !== undefined && ` · ${formatPercent(lang.rate)} resolved`}
          </span>
        </li>
      ))}
    </ul>
  );
}
