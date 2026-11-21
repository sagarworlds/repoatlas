import { describe, expect, it } from "vitest";
import { shouldCopy } from "./bundle-deps.ts";
import {
  ALLOWED_HTTP_PLATFORM_ATTRIBUTES,
  DEFAULT_SERVER_ROOT,
  escapeXmlAttr,
  parseBundleArgs,
  renderBundlePackageJson,
  renderWebConfig,
  winJoin,
} from "./bundle-lib.ts";

describe("parseBundleArgs", () => {
  it("requires --out and applies defaults", () => {
    expect(() => parseBundleArgs([])).toThrow(/--out/);
    expect(parseBundleArgs(["--out", "dist-bundle"])).toEqual({
      out: "dist-bundle",
      root: DEFAULT_SERVER_ROOT,
      skipBuild: false,
      webDist: undefined,
    });
  });

  it("reads all options and trims a trailing slash from --root", () => {
    const a = parseBundleArgs([
      "--out",
      "o",
      "--root",
      "D:\\Apps\\atlas\\",
      "--skip-build",
      "--web-dist",
      "w",
    ]);
    expect(a).toEqual({ out: "o", root: "D:\\Apps\\atlas", skipBuild: true, webDist: "w" });
  });

  it("rejects unknown flags, missing values and invalid roots", () => {
    expect(() => parseBundleArgs(["--out", "o", "--bogus"])).toThrow(/Unknown/);
    expect(() => parseBundleArgs(["--out"])).toThrow(/needs a value/);
    expect(() => parseBundleArgs(["--out", "--root", "x"])).toThrow(/needs a value/);
    expect(() => parseBundleArgs(["--out", "o", "--root", 'C:\\a"b'])).toThrow(/invalid/);
  });
});

describe("renderWebConfig", () => {
  const xml = renderWebConfig(DEFAULT_SERVER_ROOT);
  const tag = /<httpPlatform\s([^>]*?)\/>/s.exec(xml)?.[1] ?? "";
  const attrNames = [...tag.matchAll(/([A-Za-z]+)="/g)].map((m) => m[1]);

  it("uses only the five attributes HttpPlatformHandler v1.0 accepts", () => {
    expect([...attrNames].sort()).toEqual([...ALLOWED_HTTP_PLATFORM_ATTRIBUTES].sort());
    for (const banned of [
      "workingDirectory",
      "processesPerApplication",
      "startupRetryCount",
      "requestTimeout",
    ]) {
      expect(xml).not.toContain(banned);
    }
  });

  it("writes the paths from DEPLOYMENT.md section 3", () => {
    expect(xml).toContain('processPath="C:\\NodeApps\\repoatlas\\node\\node.exe"');
    expect(xml).toContain(
      'arguments="--max-old-space-size=4096 C:\\NodeApps\\repoatlas\\app\\apps\\api\\dist\\server.js"',
    );
    expect(xml).toContain('stdoutLogFile="C:\\NodeApps\\repoatlas\\logs\\stdout"');
    expect(xml).toContain('startupTimeLimit="60"');
  });

  it("escapes special characters in a custom root", () => {
    const custom = renderWebConfig("D:\\R&D\\it's <x>");
    expect(custom).toContain("D:\\R&amp;D\\it&apos;s &lt;x&gt;\\node\\node.exe");
    expect(custom).not.toContain("R&D");
  });
});

describe("small helpers", () => {
  it("escapeXmlAttr escapes the five XML specials", () => {
    expect(escapeXmlAttr(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("winJoin always uses backslashes and no doubled separator", () => {
    expect(winJoin("C:\\a\\", "b", "c")).toBe("C:\\a\\b\\c");
  });

  it("renderBundlePackageJson pins and sorts dependencies", () => {
    const json = JSON.parse(
      renderBundlePackageJson({ typescript: "6.0.3", "better-sqlite3": "13.2.0" }),
    );
    expect(Object.keys(json.dependencies)).toEqual(["better-sqlite3", "typescript"]);
    expect(json.type).toBe("module");
  });

  it("shouldCopy drops sqlite build inputs and foreign prebuilds only", () => {
    expect(shouldCopy("better-sqlite3", "deps/sqlite3/sqlite3.c")).toBe(false);
    expect(shouldCopy("better-sqlite3", "lib/database.js")).toBe(true);
    expect(shouldCopy("better-sqlite3", `prebuilds/${process.platform}-${process.arch}.node`)).toBe(
      true,
    );
    expect(shouldCopy("better-sqlite3", "prebuilds/not-this-platform.node")).toBe(false);
    expect(shouldCopy("typescript", "lib/lib.d.ts")).toBe(true);
  });
});
