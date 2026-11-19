import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@repoatlas/plugin-api", () => {
  it("loads", () => {
    expect(packageName).toBe("@repoatlas/plugin-api");
  });
});
