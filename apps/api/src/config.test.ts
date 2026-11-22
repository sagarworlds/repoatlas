import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyGrammarDefaults, parseConfig, resolveLayout } from "./config.ts";

const base = path.resolve("/base");

describe("parseConfig", () => {
  it("applies defaults", () => {
    const c = parseConfig({}, base);
    expect(c.port).toBe(4000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.analysisConcurrency).toBe(2);
    expect(c.githubToken).toBeUndefined();
    expect(c.dataDir).toBe(path.resolve(base, "data"));
  });

  it("prefers HTTP_PLATFORM_PORT over PORT and binds to loopback", () => {
    const c = parseConfig({ PORT: "5000", HTTP_PLATFORM_PORT: "51234" }, base);
    expect(c.port).toBe(51234);
    expect(c.host).toBe("127.0.0.1");
  });

  it("treats empty GITHUB_TOKEN as unset", () => {
    expect(parseConfig({ GITHUB_TOKEN: "" }, base).githubToken).toBeUndefined();
  });

  it("rejects invalid numbers", () => {
    expect(() => parseConfig({ PORT: "abc" }, base)).toThrow();
  });

  it("parses TRUST_PROXY as a hop count, loopback or off, and rejects plain true", () => {
    expect(parseConfig({}, base).trustProxy).toBe(false);
    expect(parseConfig({ TRUST_PROXY: "0" }, base).trustProxy).toBe(false);
    expect(parseConfig({ TRUST_PROXY: "1" }, base).trustProxy).toBe(1);
    expect(parseConfig({ TRUST_PROXY: "loopback" }, base).trustProxy).toBe("loopback");
    expect(() => parseConfig({ TRUST_PROXY: "true" }, base)).toThrow();
    expect(() => parseConfig({ TRUST_PROXY: "abc" }, base)).toThrow();
  });
});

describe("resolveLayout", () => {
  it("uses the repo root in dev (src layout)", () => {
    const l = resolveLayout(path.resolve("/repo/apps/api/src"));
    expect(l.appRoot).toBe(path.resolve("/repo"));
    expect(l.baseDir).toBe(path.resolve("/repo"));
  });

  it("puts .env/data one level above app in the bundle (dist layout)", () => {
    const l = resolveLayout(path.resolve("/srv/atlas/app/apps/api/dist"));
    expect(l.appRoot).toBe(path.resolve("/srv/atlas/app"));
    expect(l.baseDir).toBe(path.resolve("/srv/atlas"));
  });

  it("resolves the web dist from webRoot and DATA_DIR from baseDir", () => {
    const c = parseConfig({}, path.resolve("/srv/atlas"), path.resolve("/srv/atlas/app"));
    expect(c.webDistDir).toBe(path.resolve("/srv/atlas/app/apps/web/dist"));
    expect(c.dataDir).toBe(path.resolve("/srv/atlas/data"));
    const c2 = parseConfig({ WEB_DIST_DIR: "web" }, path.resolve("/srv/atlas"), path.resolve("/x"));
    expect(c2.webDistDir).toBe(path.resolve("/srv/atlas/web"));
  });
});

describe("applyGrammarDefaults", () => {
  const root = path.resolve("/srv/atlas/app");
  const dir = path.join(root, "grammars");

  it("sets both variables when unset and the folder exists", () => {
    const env: Record<string, string | undefined> = { TREE_SITTER_WASM_DIR: "" };
    const set = applyGrammarDefaults(env, root, () => true);
    expect(set).toEqual(["GRAMMAR_DIR", "TREE_SITTER_WASM_DIR"]);
    expect(env.GRAMMAR_DIR).toBe(dir);
    expect(env.TREE_SITTER_WASM_DIR).toBe(dir);
  });

  it("keeps explicit values", () => {
    const env: Record<string, string | undefined> = { GRAMMAR_DIR: "/custom" };
    expect(applyGrammarDefaults(env, root, () => true)).toEqual(["TREE_SITTER_WASM_DIR"]);
    expect(env.GRAMMAR_DIR).toBe("/custom");
  });

  it("does nothing when the folder is missing (dev)", () => {
    const env: Record<string, string | undefined> = {};
    expect(applyGrammarDefaults(env, root, () => false)).toEqual([]);
    expect(env).toEqual({});
  });
});
