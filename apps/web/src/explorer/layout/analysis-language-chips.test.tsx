import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalysisStats } from "../../api/types.ts";
import { AnalysisLanguageChips, summarizeLanguages } from "./analysis-language-chips.tsx";

function stats(languages: AnalysisStats["languages"]): AnalysisStats {
  return { languages } as AnalysisStats;
}

const sample = stats({
  python: { files: 1, bytes: 5, pluginTier: 1, references: { total: 10, resolved: 4 } },
  typescript: { files: 7, bytes: 5, pluginTier: 3, references: { total: 20, resolved: 19 } },
  go: { files: 2, bytes: 5, pluginTier: 1 },
});

describe("summarizeLanguages", () => {
  it("is empty without stats and sorts by file count", () => {
    expect(summarizeLanguages(null)).toEqual([]);
    expect(summarizeLanguages(sample).map((l) => l.id)).toEqual(["typescript", "go", "python"]);
  });

  it("leaves the rate undefined for old analyses and zero references", () => {
    const rates = Object.fromEntries(summarizeLanguages(sample).map((l) => [l.id, l.rate]));
    expect(rates).toEqual({ typescript: 0.95, go: undefined, python: 0.4 });
  });
});

describe("AnalysisLanguageChips", () => {
  it("shows files, tier and rate as text, with a tier tooltip", () => {
    render(<AnalysisLanguageChips stats={sample} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("TypeScript · 7 files · Tier 3 · 95% resolved");
    expect(items[0]).toHaveAttribute("title", expect.stringContaining("compiler"));
    expect(items[1]).toHaveTextContent("Go · 2 files · Tier 1");
    expect(items[1]).not.toHaveTextContent("resolved");
    expect(items[2]).toHaveTextContent("Python · 1 file · Tier 1 · 40% resolved");
    expect(items[2]).toHaveAttribute("title", expect.stringContaining("approximate"));
  });

  it("renders nothing without languages", () => {
    const { container } = render(<AnalysisLanguageChips stats={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
