import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@repoatlas/schema", () => {
  it("loads", () => {
    expect(packageName).toBe("@repoatlas/schema");
  });
});
