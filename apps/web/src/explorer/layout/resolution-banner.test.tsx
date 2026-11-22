import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisStats } from "../../api/types.ts";
import { makeAnalysis } from "../../test/utils.tsx";
import { buildNotices, ResolutionBanner } from "./resolution-banner.tsx";

function stats(over: Partial<AnalysisStats> = {}): AnalysisStats {
  return {
    schemaVersion: 1,
    analyzerVersion: "x",
    commitSha: "abc",
    languages: { typescript: { files: 3, bytes: 10, pluginTier: 1 } },
    nodesByKind: {},
    edgesByKind: {},
    edgesByConfidence: { exact: 0, inferred: 0, "name-match": 0 },
    references: { total: 100, resolved: 90, unresolved: 10 },
    skippedFiles: [],
    parseErrorFiles: 0,
    droppedInvalidEdges: 0,
    pluginErrors: [],
    timingsMs: {},
    ...over,
  };
}

const refs = (resolved: number, total: number) => ({
  references: { total, resolved, unresolved: total - resolved },
});

beforeEach(() => window.sessionStorage.clear());

describe("buildNotices", () => {
  it("is empty for good stats and for missing stats", () => {
    expect(buildNotices(stats())).toEqual([]);
    expect(buildNotices(null)).toEqual([]);
  });

  it("warns below 50% resolved, not at exactly 50% or without references", () => {
    expect(buildNotices(stats(refs(49, 100)))).toHaveLength(1);
    expect(buildNotices(stats(refs(50, 100)))).toEqual([]);
    expect(buildNotices(stats(refs(0, 0)))).toEqual([]);
  });

  it("mentions languages, truncation and plugin errors", () => {
    const notices = buildNotices(
      stats({
        ...refs(1, 10),
        truncated: true,
        skippedFiles: [{ reason: "too-large", count: 4 }],
        pluginErrors: [{ plugin: "python", stage: "parse", message: "boom" }],
      }),
    );
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain(
      "Call links for TypeScript are approximate (dashed lines are name matches)",
    );
    expect(notices[0]).toContain("Only 10%");
    expect(notices[1]).toContain("4 files skipped");
    expect(notices[2]).toContain("python");
  });
});

describe("buildNotices per language", () => {
  const langs = (a: [number, number], b: [number, number]) => ({
    languages: {
      typescript: {
        files: 3,
        bytes: 10,
        pluginTier: 3 as const,
        references: { resolved: a[0], total: a[1] },
      },
      python: {
        files: 2,
        bytes: 10,
        pluginTier: 1 as const,
        references: { resolved: b[0], total: b[1] },
      },
    },
    // The overall rate is high on purpose: only the per-language rate must matter.
    ...refs(95, 100),
  });

  it("names only the languages below 50%", () => {
    expect(buildNotices(stats(langs([90, 100], [3, 10])))).toEqual([
      "Call links for Python are approximate (dashed lines are name matches).",
    ]);
  });

  it("lists several low languages in one notice", () => {
    expect(buildNotices(stats(langs([1, 10], [3, 10])))).toEqual([
      "Call links for Python and TypeScript are approximate (dashed lines are name matches).",
    ]);
  });

  it("ignores languages without call references and at exactly 50%", () => {
    expect(buildNotices(stats(langs([0, 0], [5, 10])))).toEqual([]);
  });
});

describe("ResolutionBanner", () => {
  const low = stats(refs(1, 10));

  it("renders nothing without notices", () => {
    const { container } = render(<ResolutionBanner analysis={makeAnalysis({ stats: stats() })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is dismissible and remembers the dismissal per analysis", async () => {
    const a = makeAnalysis({ id: "an_1", stats: low });
    const first = render(<ResolutionBanner analysis={a} />);
    expect(screen.getByText(/Call links for TypeScript are approximate/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Call links for TypeScript are approximate/)).not.toBeInTheDocument();
    first.unmount();

    const second = render(<ResolutionBanner analysis={a} />);
    expect(screen.queryByText(/Call links for TypeScript are approximate/)).not.toBeInTheDocument();
    second.unmount();

    render(<ResolutionBanner analysis={makeAnalysis({ id: "an_2", stats: low })} />);
    expect(screen.getByText(/Call links for TypeScript are approximate/)).toBeInTheDocument();
  });
});
