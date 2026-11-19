import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@repoatlas/store", () => {
  it("loads", () => {
    expect(packageName).toBe("@repoatlas/store");
  });
});
