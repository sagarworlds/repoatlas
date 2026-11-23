import { describe, expect, it, vi } from "vitest";
import type { ExtractionPool } from "./pool.ts";
import { acquireSharedPool, sharedPoolStats, shutdownSharedPool } from "./shared-pool.ts";

function fakePool(): ExtractionPool & { closed: number; max: number } {
  const pool = {
    closed: 0,
    max: 0,
    openSession: () => {
      throw new Error("unused");
    },
    allowWorkers(n: number) {
      pool.max = Math.max(pool.max, n);
    },
    stats: () => ({ spawned: 0, replaced: 0, alive: 0, completed: 0 }),
    async close() {
      pool.closed++;
    },
  };
  return pool;
}

describe("shared pool", () => {
  it("is created lazily, shared by concurrent leases and closed after the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const pool = fakePool();
      const create = vi.fn((n: number) => {
        pool.max = n;
        return pool;
      });
      const a = acquireSharedPool(2, { create, idleTimeoutMs: 1000 });
      const b = acquireSharedPool(4, { create, idleTimeoutMs: 1000 });
      expect(create).toHaveBeenCalledTimes(1);
      expect(a?.pool).toBe(b?.pool);
      expect(pool.max).toBe(4);
      expect(sharedPoolStats()).toBeDefined();

      a?.release();
      a?.release(); // releasing twice is harmless
      vi.advanceTimersByTime(5000);
      expect(pool.closed).toBe(0); // b still holds it

      b?.release();
      vi.advanceTimersByTime(999);
      expect(pool.closed).toBe(0);
      vi.advanceTimersByTime(2);
      expect(pool.closed).toBe(1);
      expect(sharedPoolStats()).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await shutdownSharedPool();
    }
  });

  it("cancels the idle timer when someone acquires again", async () => {
    vi.useFakeTimers();
    try {
      const pool = fakePool();
      const create = () => pool;
      acquireSharedPool(2, { create, idleTimeoutMs: 1000 })?.release();
      vi.advanceTimersByTime(500);
      const again = acquireSharedPool(2, { create, idleTimeoutMs: 1000 });
      vi.advanceTimersByTime(5000);
      expect(pool.closed).toBe(0);
      again?.release();
    } finally {
      vi.useRealTimers();
      await shutdownSharedPool();
    }
  });

  it("returns undefined when no pool can be created", () => {
    expect(acquireSharedPool(2, { create: () => undefined })).toBeUndefined();
  });

  it("shutdownSharedPool closes the pool immediately", async () => {
    const pool = fakePool();
    acquireSharedPool(2, { create: () => pool });
    await shutdownSharedPool();
    expect(pool.closed).toBe(1);
  });
});
