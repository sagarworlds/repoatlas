import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@repoatlas/treesitter", () => {
  it("loads", () => {
    expect(packageName).toBe("@repoatlas/treesitter");
  });
});
