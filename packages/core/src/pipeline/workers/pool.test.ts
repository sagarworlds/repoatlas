import { afterEach, describe, expect, it } from "vitest";
import { acceptExtraction } from "./accept.ts";
import { locateWorkerEntry, type WorkerEntry } from "./entry-location.ts";
import { createExtractionPool, type ExtractionPool, type PoolFile } from "./pool.ts";

// These tests start real worker threads (through tsx) running a fake worker entry.
const real = locateWorkerEntry();
if (real === undefined) throw new Error("worker entry not found");

function fakeEntry(file: string): WorkerEntry {
  return {
    url: new URL(`./test-support/${file}`, import.meta.url),
    execArgv: real?.execArgv ?? [],
  };
}

function file(path: string, content = "ok"): PoolFile {
  return { path, bytes: content.length, content, language: "python" };
}

const pools: ExtractionPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

function makePool(options: Partial<Parameters<typeof createExtractionPool>[0]> = {}) {
  const pool = createExtractionPool({
    maxWorkers: 2,
    entry: fakeEntry("fake-worker-entry.ts"),
    ...options,
  });
  pools.push(pool);
  return pool;
}

const T = 40_000;

describe("extraction pool", () => {
  it(
    "returns every file's own result, whatever order the workers finish in",
    async () => {
      const pool = makePool();
      const session = pool.openSession("python", {});
      const files = Array.from({ length: 24 }, (_, i) =>
        file(`f${i}.py`, i % 3 === 0 ? `SLOW:${(i % 5) * 20}` : "ok"),
      );
      const outcomes = await Promise.all(files.map((f) => session.extract(f)));
      outcomes.forEach((outcome, i) => {
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(acceptExtraction(outcome.extraction, `f${i}.py`)).toBeDefined();
      });
      expect(pool.stats().spawned).toBe(2);
      expect(pool.stats().completed).toBe(24);
      session.close();
    },
    T,
  );

  it(
    "isolates plugin failures and invalid output to the file that caused them",
    async () => {
      const pool = makePool();
      const session = pool.openSession("python", {});
      const [fail, bad, fine] = await Promise.all([
        session.extract(file("a.py", "FAIL")),
        session.extract(file("b.py", "BAD")),
        session.extract(file("c.py")),
      ]);
      expect(fail).toMatchObject({ ok: false, reason: "extract-error" });
      // The pool does not judge the content; the caller validates it with the schema.
      expect(bad.ok && acceptExtraction(bad.extraction, "b.py")).toBeFalsy();
      expect(fine.ok).toBe(true);
      expect(pool.stats().replaced).toBe(0);
    },
    T,
  );

  it(
    "replaces a worker that exits and fails only the file it was running",
    async () => {
      const pool = makePool({ maxWorkers: 2 });
      const session = pool.openSession("python", {});
      const files = [
        file("crash.py", "CRASH"),
        ...Array.from({ length: 12 }, (_, i) => file(`ok${i}.py`, "SLOW:10")),
      ];
      const outcomes = await Promise.all(files.map((f) => session.extract(f)));
      expect(outcomes[0]).toMatchObject({ ok: false, reason: "extract-error" });
      expect(outcomes.slice(1).every((o) => o.ok)).toBe(true);
      expect(pool.stats().replaced).toBeGreaterThanOrEqual(1);
      // The pool is still usable afterwards.
      expect((await session.extract(file("after.py"))).ok).toBe(true);
    },
    T,
  );

  it(
    "survives an uncaught exception inside a worker",
    async () => {
      const pool = makePool();
      const session = pool.openSession("python", {});
      const [thrown, fine] = await Promise.all([
        session.extract(file("t.py", "THROW")),
        session.extract(file("ok.py", "SLOW:30")),
      ]);
      expect(thrown).toMatchObject({ ok: false, reason: "extract-error" });
      expect(fine.ok).toBe(true);
      expect((await session.extract(file("after.py"))).ok).toBe(true);
    },
    T,
  );

  it(
    "kills a worker that does not answer (watchdog) and reports a timeout",
    async () => {
      const pool = makePool({ watchdogMs: 600 });
      const session = pool.openSession("python", {});
      const started = Date.now();
      const [hung, fine] = await Promise.all([
        session.extract(file("hang.py", "HANG")),
        session.extract(file("ok.py")),
      ]);
      expect(hung).toMatchObject({ ok: false, reason: "timeout" });
      expect(fine.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect((await session.extract(file("after.py"))).ok).toBe(true);
      expect(pool.stats().replaced).toBeGreaterThanOrEqual(1);
    },
    T,
  );

  it(
    "retries files that were only waiting behind a crashing file",
    async () => {
      // One worker, two files in flight: the crash blames the first, the second is retried.
      const pool = makePool({ maxWorkers: 1, maxInFlightPerWorker: 2 });
      const session = pool.openSession("python", {});
      const [crash, waiting] = await Promise.all([
        session.extract(file("crash.py", "CRASH")),
        session.extract(file("waiting.py")),
      ]);
      expect(crash.ok).toBe(false);
      expect(waiting.ok).toBe(true);
    },
    T,
  );

  it(
    "drops queued files when the session is aborted",
    async () => {
      const pool = makePool({ maxWorkers: 1, maxInFlightPerWorker: 1 });
      const controller = new AbortController();
      const session = pool.openSession("python", {}, controller.signal);
      const pending = Array.from({ length: 30 }, (_, i) =>
        session.extract(file(`s${i}.py`, "SLOW:100")),
      );
      setTimeout(() => controller.abort(), 400);
      const started = Date.now();
      const outcomes = await Promise.all(pending);
      const aborted = outcomes.filter((o) => !o.ok && o.reason === "aborted").length;
      expect(aborted).toBeGreaterThan(15);
      expect(Date.now() - started).toBeLessThan(2500); // 30 x 100 ms would take 3 s
      expect(await session.extract(file("late.py"))).toMatchObject({ reason: "aborted" });
    },
    T,
  );

  it(
    "ends pending files as aborted when the pool is closed",
    async () => {
      const pool = makePool({ maxWorkers: 1 });
      const session = pool.openSession("python", {});
      const pending = Array.from({ length: 6 }, (_, i) =>
        session.extract(file(`p${i}.py`, "HANG")),
      );
      await new Promise((r) => setTimeout(r, 1500));
      await pool.close();
      const outcomes = await Promise.all(pending);
      expect(outcomes.every((o) => !o.ok && o.reason === "aborted")).toBe(true);
      expect(() => pool.openSession("python", {})).toThrow();
    },
    T,
  );

  it(
    "reports unavailable when workers cannot start",
    async () => {
      const pool = makePool({ entry: fakeEntry("broken-start-entry.ts") });
      const session = pool.openSession("python", {});
      const outcomes = await Promise.all([
        session.extract(file("a.py")),
        session.extract(file("b.py")),
      ]);
      expect(outcomes.every((o) => !o.ok && o.reason === "unavailable")).toBe(true);
      expect(await session.extract(file("c.py"))).toMatchObject({ reason: "unavailable" });
    },
    T,
  );

  it(
    "replaces workers after recycleAfterJobs files",
    async () => {
      const pool = makePool({ maxWorkers: 1, recycleAfterJobs: 4 });
      const session = pool.openSession("python", {});
      const outcomes = await Promise.all(
        Array.from({ length: 11 }, (_, i) => session.extract(file(`r${i}.py`))),
      );
      expect(outcomes.every((o) => o.ok)).toBe(true);
      expect(pool.stats().spawned).toBeGreaterThanOrEqual(3);
    },
    T,
  );

  it("refuses prepare info that cannot be cloned to a thread", () => {
    const pool = makePool();
    expect(() => pool.openSession("python", { fn: () => 1 })).toThrow();
  });

  it("sends Map and Set info across unchanged", () => {
    const pool = makePool();
    expect(() =>
      pool.openSession("python", { roots: new Set(["a"]), table: new Map([["m", ["f"]]]) }),
    ).not.toThrow();
  });
});
