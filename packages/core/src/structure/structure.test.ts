import { describe, expect, it } from "vitest";
import { buildStructure } from "./structure.ts";

describe("buildStructure", () => {
  const { nodes, edges } = buildStructure({
    repoName: "demo",
    files: [
      { path: "src/b/z.ts", language: "typescript", bytes: 10, loc: 3, isTest: true },
      { path: "main.ts", language: "typescript", bytes: 5 },
      { path: "src/a.ts", language: "typescript", bytes: 7 },
    ],
  });

  it("creates repo, root dir, dirs with claimed files and file nodes", () => {
    expect(nodes.map((n) => n.id)).toEqual([
      "repo:",
      "dir:",
      "dir:src",
      "dir:src/b",
      "file:main.ts",
      "file:src/a.ts",
      "file:src/b/z.ts",
    ]);
    expect(nodes.find((n) => n.id === "dir:")?.name).toBe("demo");
    expect(nodes.find((n) => n.id === "dir:src/b")?.name).toBe("b");
  });

  it("sets parentId and matching contains edges", () => {
    const z = nodes.find((n) => n.id === "file:src/b/z.ts");
    expect(z?.parentId).toBe("dir:src/b");
    expect(z?.meta).toEqual({ loc: 3, isTest: true });
    expect(nodes.find((n) => n.id === "dir:")?.parentId).toBe("repo:");
    for (const n of nodes) {
      if (n.parentId === undefined) continue;
      expect(edges).toContainEqual({
        src: n.parentId,
        dst: n.id,
        kind: "contains",
        confidence: "exact",
      });
    }
    expect(edges).toHaveLength(nodes.length - 1);
  });

  it("creates only repo and root dir when no files are claimed", () => {
    const empty = buildStructure({ repoName: "x", files: [] });
    expect(empty.nodes.map((n) => n.id)).toEqual(["repo:", "dir:"]);
  });

  it("marks directories that contain only test files as test directories", () => {
    const meta = (id: string) => nodes.find((n) => n.id === id)?.meta;
    expect(meta("dir:src/b")).toEqual({ isTest: true }); // only z.ts (a test)
    expect(meta("dir:src")).toBeUndefined(); // has a.ts
    expect(meta("dir:")).toBeUndefined();
  });
});
