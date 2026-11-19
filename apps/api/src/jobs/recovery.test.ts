import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnalysisRecord } from "@repoatlas/store";
import { describe, expect, it } from "vitest";
import { planRecovery, readAttempts, writeAttempts } from "./recovery.ts";
import { decodeError, encodeError } from "./storage.ts";

function record(id: string, status: AnalysisRecord["status"]): AnalysisRecord {
  return {
    id,
    owner: "o",
    repo: "r",
    ref: "main",
    commitSha: null,
    analyzerVersion: "1",
    status,
    progress: null,
    stats: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  };
}

describe("planRecovery", () => {
  it("re-queues a running analysis once and counts the retry", () => {
    const plan = planRecovery([record("a", "parsing")], {});
    expect(plan).toEqual({ requeue: ["a"], fail: [], nextAttempts: { a: 1 } });
  });

  it("fails a running analysis that was already retried", () => {
    const plan = planRecovery([record("a", "fetching")], { a: 1 });
    expect(plan).toEqual({ requeue: [], fail: ["a"], nextAttempts: {} });
  });

  it("re-queues a never-started analysis without spending the retry", () => {
    expect(planRecovery([record("q", "queued")], {}).nextAttempts).toEqual({});
    expect(planRecovery([record("q", "queued")], { q: 1 })).toEqual({
      requeue: ["q"],
      fail: [],
      nextAttempts: { q: 1 },
    });
  });

  it("drops counters of analyses that are no longer unfinished", () => {
    const plan = planRecovery([record("a", "persisting")], { gone: 1, a: 0 });
    expect(plan.nextAttempts).toEqual({ a: 1 });
  });

  it("handles every non-terminal status", () => {
    for (const status of ["fetching", "parsing", "resolving", "persisting"] as const) {
      expect(planRecovery([record("x", status)], {}).requeue).toEqual(["x"]);
    }
  });
});

describe("attempts file", () => {
  it("round-trips, and a missing or corrupt file means no retries spent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ra-recovery-"));
    try {
      expect(await readAttempts(dir)).toEqual({});
      await writeAttempts(dir, { a: 1 });
      expect(await readAttempts(dir)).toEqual({ a: 1 });
      await writeFile(path.join(dir, "recovery.json"), "{not json");
      expect(await readAttempts(dir)).toEqual({});
      await writeFile(path.join(dir, "recovery.json"), JSON.stringify({ attempts: { a: "x" } }));
      expect(await readAttempts(dir)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stored errors", () => {
  it("round-trips code and message and tolerates plain strings", () => {
    expect(decodeError(encodeError("TIMEOUT", "slow"))).toEqual({
      code: "TIMEOUT",
      message: "slow",
    });
    expect(decodeError("legacy text")).toEqual({ code: "INTERNAL", message: "legacy text" });
    expect(decodeError(null)).toBeNull();
  });
});
