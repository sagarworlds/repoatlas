import type { GraphEdge, Unresolved } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import type { PluginRun } from "./extract.ts";
import { referenceCountsByLanguage } from "./reference-stats.ts";

function fakeRun(): PluginRun {
  // Only the fields the function reads: plugin.languages and extractions.
  return {
    plugin: { languages: ["python"] },
    extractions: [
      {
        file: "a.py",
        language: "python",
        definitions: [],
        imports: [],
        // 4 raw calls: one resolved, one unresolved, two that are builtins/external.
        references: Array.from({ length: 4 }, (_, i) => ({ line: i + 1, kind: "call", name: "x" })),
        parseErrors: 0,
      },
      {
        file: "empty.py",
        language: "python",
        definitions: [],
        imports: [],
        references: [],
        parseErrors: 0,
      },
    ],
  } as unknown as PluginRun;
}

describe("referenceCountsByLanguage", () => {
  it("counts only references that could be resolved inside the repository", () => {
    const edges: GraphEdge[] = [
      {
        src: "sym:a.py#f",
        dst: "sym:a.py#g",
        kind: "calls",
        confidence: "inferred",
        meta: { callCount: 1 },
      },
    ];
    const unresolved: Unresolved[] = [{ file: "a.py", line: 2, name: "x", kind: "call" }];
    const counts = referenceCountsByLanguage(fakeRun(), edges, unresolved, {
      languageOfFile: new Map([
        ["a.py", "python"],
        ["empty.py", "python"],
      ]),
      fileOfNode: new Map([["sym:a.py#f", "a.py"]]),
    });
    // The two ignored calls (builtins, externals) are in neither number.
    expect(counts.get("python")).toEqual({ total: 2, resolved: 1, unresolved: 1 });
  });

  it("gives a language with files but no calls an all-zero entry", () => {
    const run = fakeRun();
    run.extractions = run.extractions.filter((e) => e.file === "empty.py");
    const counts = referenceCountsByLanguage(run, [], [], {
      languageOfFile: new Map([["empty.py", "python"]]),
      fileOfNode: new Map(),
    });
    expect(counts.get("python")).toEqual({ total: 0, resolved: 0, unresolved: 0 });
  });
});
