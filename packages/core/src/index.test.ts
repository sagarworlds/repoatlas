import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@repoatlas/core", () => {
  it("loads", () => {
    expect(packageName).toBe("@repoatlas/core");
  });
});
