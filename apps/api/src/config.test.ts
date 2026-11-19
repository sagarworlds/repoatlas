import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

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
