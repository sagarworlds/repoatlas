import { describe, expect, it } from "vitest";
import { computeWorkerCount, MAX_POOL_WORKERS } from "./worker-count.ts";

describe("computeWorkerCount", () => {
  it("is 0 (single thread) when no setting is given", () => {
    expect(computeWorkerCount(undefined, 100_000)).toBe(0);
  });

  it("uses min(configured, files / 50, 8)", () => {
    expect(computeWorkerCount(4, 1000)).toBe(4);
    expect(computeWorkerCount(4, 150)).toBe(3);
    expect(computeWorkerCount(32, 100_000)).toBe(MAX_POOL_WORKERS);
  });

  it("uses CPUs minus one for auto", () => {
    expect(computeWorkerCount("auto", 10_000, { cpus: 4 })).toBe(3);
    expect(computeWorkerCount("auto", 10_000, { cpus: 64 })).toBe(8);
  });

  it("disables the pool for 0, 1, or a one-core machine", () => {
    expect(computeWorkerCount(0, 10_000)).toBe(0);
    expect(computeWorkerCount(1, 10_000)).toBe(0);
    expect(computeWorkerCount("auto", 10_000, { cpus: 2 })).toBe(0);
    expect(computeWorkerCount("auto", 10_000, { cpus: 1 })).toBe(0);
  });

  it("disables the pool for small repositories (files / 50 < 2)", () => {
    expect(computeWorkerCount(8, 99)).toBe(0);
    expect(computeWorkerCount(8, 100)).toBe(2);
  });

  it("lets tests lower the files-per-worker rule", () => {
    expect(computeWorkerCount(2, 4, { filesPerWorker: 1 })).toBe(2);
  });
});
