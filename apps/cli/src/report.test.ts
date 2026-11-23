import type { AnalysisStats } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { evaluateQuality, formatStats } from "./report.ts";

function makeStats(overrides: Partial<AnalysisStats> = {}): AnalysisStats {
  return {
    schemaVersion: 1,
    analyzerVersion: "1",
    commitSha: "a".repeat(40),
    languages: { typescript: { files: 10, bytes: 2000, pluginTier: 3 } },
    nodesByKind: { repo: 1, directory: 2, file: 10, function: 20, class: 3 },
    edgesByKind: { contains: 35, imports: 12, calls: 40 },
    edgesByConfidence: { exact: 80, inferred: 15, "name-match": 5 },
    references: { total: 50, resolved: 46, unresolved: 4 },
    skippedFiles: [
      { reason: "binary", count: 2 },
      { reason: "lockfile", count: 1 },
    ],
    parseErrorFiles: 1,
    droppedInvalidEdges: 0,
    pluginErrors: [],
    timingsMs: { walk: 12.4, extract: 300, total: 330 },
    ...overrides,
  };
}

const META = { owner: "acme", repo: "demo", ref: "main", commitSha: "b".repeat(40) };

describe("formatStats", () => {
  it("contains every section with the expected numbers", () => {
    const text = formatStats(makeStats(), META);
    expect(text).toContain("acme/demo@bbbbbbbbbbbb (ref: main)");
    expect(text).toContain("typescript: 10 files, 2000 bytes, tier 3");
    expect(text).toContain("function: 20");
    expect(text).toContain("calls: 40");
    expect(text).toContain("exact: 80 (80.0%)");
    expect(text).toContain("name-match: 5 (5.0%)");
    expect(text).toContain("resolved: 46 / 50 (92.0%)");
    expect(text).toContain("binary: 2");
    expect(text).toContain("files with parse errors: 1");
    expect(text).toContain("dropped invalid edges: 0");
    expect(text).toContain("walk: 12");
    expect(text).toContain("PASS");
  });

  it("prints WARN with reasons and plugin errors", () => {
    const text = formatStats(
      makeStats({
        references: { total: 100, resolved: 50, unresolved: 50 },
        droppedInvalidEdges: 3,
        pluginErrors: [{ plugin: "typescript", stage: "analyze", message: "boom" }],
      }),
      META,
    );
    expect(text).toContain("WARN:");
    expect(text).toContain("resolution rate 50.0%");
    expect(text).toContain("3 invalid edges");
    expect(text).toContain("typescript [analyze]: boom");
  });

  it("handles an empty graph without dividing by zero", () => {
    const text = formatStats(
      makeStats({
        languages: {},
        references: { total: 0, resolved: 0, unresolved: 0 },
        edgesByConfidence: { exact: 0, inferred: 0, "name-match": 0 },
        skippedFiles: [],
      }),
      META,
    );
    expect(text).toContain("n/a");
    expect(text).toContain("(none)");
  });
});

describe("per-language resolution", () => {
  const polyglot = makeStats({
    languages: {
      typescript: { files: 3, bytes: 1, pluginTier: 3, references: { total: 100, resolved: 95 } },
      python: { files: 9, bytes: 1, pluginTier: 1, references: { total: 100, resolved: 60 } },
    },
    references: { total: 200, resolved: 155, unresolved: 45 },
  });

  it("prints a rate and verdict per language", () => {
    const text = formatStats(polyglot, META);
    expect(text).toContain("typescript: 95 / 100 (95.0%), target 90% PASS");
    expect(text).toContain("python: 60 / 100 (60.0%), target 65% WARN");
  });

  it("warns for the language that misses its own target", () => {
    const verdict = evaluateQuality(polyglot);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("python resolution rate 60.0%");
    expect(verdict.reasons.join(" ")).not.toContain("typescript resolution rate");
  });
});

describe("five-language targets", () => {
  const languages = {
    typescript: { files: 1, bytes: 1, pluginTier: 3, references: { total: 100, resolved: 90 } },
    javascript: { files: 1, bytes: 1, pluginTier: 3, references: { total: 100, resolved: 89 } },
    python: { files: 1, bytes: 1, pluginTier: 1, references: { total: 100, resolved: 65 } },
    go: { files: 1, bytes: 1, pluginTier: 1, references: { total: 100, resolved: 75 } },
    java: { files: 1, bytes: 1, pluginTier: 1, references: { total: 100, resolved: 74 } },
  } as const;
  const stats = makeStats({
    languages,
    references: { total: 500, resolved: 393, unresolved: 107 },
  });

  it("applies 90 / 90 / 65 / 75 / 75 and marks PASS or WARN per language", () => {
    const text = formatStats(stats, META);
    expect(text).toContain("typescript: 90 / 100 (90.0%), target 90% PASS");
    expect(text).toContain("javascript: 89 / 100 (89.0%), target 90% WARN");
    expect(text).toContain("python: 65 / 100 (65.0%), target 65% PASS");
    expect(text).toContain("go: 75 / 100 (75.0%), target 75% PASS");
    expect(text).toContain("java: 74 / 100 (74.0%), target 75% WARN");
    const reasons = evaluateQuality(stats).reasons.join(" ");
    expect(reasons).toContain("javascript resolution rate");
    expect(reasons).toContain("java resolution rate");
    expect(reasons).not.toContain("go resolution rate");
  });

  it("prints the name-match verdict", () => {
    expect(formatStats(stats, META)).toContain("name-match share of edges: 5.0%, limit 20% PASS");
    const high = makeStats({ edgesByConfidence: { exact: 10, inferred: 0, "name-match": 10 } });
    expect(formatStats(high, META)).toContain("limit 20% WARN");
  });
});

describe("evaluateQuality", () => {
  it("applies the language-specific target of the dominant language", () => {
    const python = makeStats({
      languages: { python: { files: 5, bytes: 1, pluginTier: 2 } },
      references: { total: 100, resolved: 70, unresolved: 30 },
    });
    expect(evaluateQuality(python).ok).toBe(true);
    const ts = makeStats({ references: { total: 100, resolved: 70, unresolved: 30 } });
    expect(evaluateQuality(ts).ok).toBe(false);
  });

  it("warns about a high name-match share except for ruby", () => {
    const confidence = { exact: 10, inferred: 0, "name-match": 10 };
    expect(evaluateQuality(makeStats({ edgesByConfidence: confidence })).ok).toBe(false);
    const ruby = makeStats({
      languages: { ruby: { files: 3, bytes: 1, pluginTier: 1 } },
      edgesByConfidence: confidence,
    });
    expect(evaluateQuality(ruby).ok).toBe(true);
  });
});
