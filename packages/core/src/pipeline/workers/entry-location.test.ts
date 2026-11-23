import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_WORKER_FILE, locateWorkerEntry } from "./entry-location.ts";

describe("locateWorkerEntry", () => {
  it("finds worker-entry.ts with a tsx loader when running from sources", () => {
    const entry = locateWorkerEntry();
    expect(entry?.url.pathname.endsWith("/workers/worker-entry.ts")).toBe(true);
    expect(entry?.execArgv[0]).toBe("--import");
    expect(entry?.execArgv[1]).toMatch(/^file:/);
  });

  it("returns undefined when the bundled worker file is not next to the bundle", () => {
    expect(
      locateWorkerEntry(pathToFileURL(join(tmpdir(), "no-such-dir", "server.js")).href),
    ).toBeUndefined();
    expect(BUNDLED_WORKER_FILE).toBe("extract-worker.js");
  });
});
