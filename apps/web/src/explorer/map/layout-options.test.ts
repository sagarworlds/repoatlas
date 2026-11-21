import { describe, expect, it } from "vitest";
import { DRAFT_QUALITY_THRESHOLD, fcoseOptions } from "./layout-options.ts";

describe("fcoseOptions", () => {
  it("uses the cheap settings above the draft threshold", () => {
    const big = fcoseOptions({
      nodeCount: DRAFT_QUALITY_THRESHOLD + 1,
      fresh: true,
      animate: true,
    });
    expect(big.quality).toBe("draft");
    expect(big.tile).toBe(false);
    expect(big.packComponents).toBe(false);
    expect(big.nodeDimensionsIncludeLabels).toBe(false);
    expect(big.animate).toBe(false);
  });

  it("keeps the nicer settings for small graphs", () => {
    const small = fcoseOptions({ nodeCount: 50, fresh: true, animate: true });
    expect(small.quality).toBe("default");
    expect(small.tile).toBe(true);
    expect(small.packComponents).toBe(true);
  });
});
