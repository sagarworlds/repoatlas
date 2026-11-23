import type { LanguagePlugin } from "@repoatlas/plugin-api";
import type { FileExtraction } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { createWorkerHandler } from "./worker-handler.ts";

function emptyExtraction(path: string): FileExtraction {
  return {
    file: path,
    language: "python",
    definitions: [],
    imports: [],
    references: [],
    parseErrors: 0,
  };
}

function fakePlugin(extract: LanguagePlugin["extract"]): LanguagePlugin {
  return {
    id: "fake",
    version: "1",
    languages: ["python"],
    tier: 1,
    detect: () => [],
    extract,
    resolve: async () => ({ imports: [], edges: [], externals: [], unresolved: [] }),
  };
}

const file = { path: "a.py", bytes: 1, content: "x", language: "python" } as const;

describe("createWorkerHandler", () => {
  it("passes the session info and the file to the plugin", async () => {
    const seen: unknown[] = [];
    const plugin = fakePlugin(async (f, info) => {
      seen.push(f.path, info);
      return emptyExtraction(f.path);
    });
    const handler = createWorkerHandler((id) => (id === "fake" ? plugin : undefined));
    await handler.handle({
      type: "session",
      sessionId: 1,
      pluginId: "fake",
      info: { roots: new Set(["src"]) },
    });
    const reply = await handler.handle({ type: "extract", jobId: 7, sessionId: 1, ...file });
    expect(reply?.type).toBe("result");
    expect(seen[0]).toBe("a.py");
    expect(seen[1]).toEqual({ roots: new Set(["src"]) });
  });

  it("turns a throwing plugin into a failure reply", async () => {
    const plugin = fakePlugin(async () => {
      throw new Error("bad grammar");
    });
    const handler = createWorkerHandler(() => plugin);
    await handler.handle({ type: "session", sessionId: 1, pluginId: "fake", info: {} });
    expect(await handler.handle({ type: "extract", jobId: 1, sessionId: 1, ...file })).toEqual({
      type: "failure",
      jobId: 1,
      message: "bad grammar",
    });
  });

  it("fails files of unknown sessions and plugins, and forgets ended sessions", async () => {
    const plugin = fakePlugin(async (f) => emptyExtraction(f.path));
    const handler = createWorkerHandler((id) => (id === "fake" ? plugin : undefined));
    const extract = async (jobId: number, sessionId: number) =>
      (await handler.handle({ type: "extract", jobId, sessionId, ...file }))?.type;
    expect(await extract(1, 9)).toBe("failure");
    await handler.handle({ type: "session", sessionId: 2, pluginId: "nope", info: {} });
    expect(await extract(2, 2)).toBe("failure");
    await handler.handle({ type: "session", sessionId: 3, pluginId: "fake", info: {} });
    expect(await extract(3, 3)).toBe("result");
    await handler.handle({ type: "end-session", sessionId: 3 });
    expect(await extract(4, 3)).toBe("failure");
  });
});
