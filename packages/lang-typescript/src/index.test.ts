import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@repoatlas/lang-typescript", () => {
  it("loads", () => {
    expect(packageName).toBe("@repoatlas/lang-typescript");
  });
});
