import { describe, expect, it } from "vitest";
import { ANALYZER_VERSION } from "./version.ts";

describe("ANALYZER_VERSION", () => {
  // Bump it (and this test) whenever the pipeline produces different output for the same
  // input. Version 2: JavaScript, Go and Java support (M4).
  it("is pinned so that stored pre-M4 analyses are recomputed", () => {
    expect(ANALYZER_VERSION).toBe("2");
  });
});
