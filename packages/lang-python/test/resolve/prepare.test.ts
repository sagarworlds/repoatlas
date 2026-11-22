import { describe, expect, it } from "vitest";
import {
  computeProjectInfo,
  inferConventionalRoots,
  isStdlibModule,
  moduleNameFor,
  PYTHON_STDLIB_MODULES,
  pythonPrepare,
  readProjectInfo,
  readPyproject,
  readSetupCfg,
} from "../../src/prepare/index.ts";
import { projectContext } from "./helpers.ts";

const py = (...paths: string[]): Record<string, string> =>
  Object.fromEntries(paths.map((p) => [p, ""]));

describe("moduleNameFor", () => {
  it("uses the longest matching root", () => {
    const roots = ["", "src"];
    expect(moduleNameFor("src/shop/models.py", roots)).toBe("shop.models");
    expect(moduleNameFor("scripts/seed.py", roots)).toBe("scripts.seed");
  });

  it("maps __init__.py to its package and a root-level __init__.py to nothing", () => {
    expect(moduleNameFor("src/shop/__init__.py", ["", "src"])).toBe("shop");
    expect(moduleNameFor("src/__init__.py", ["", "src"])).toBeUndefined();
  });

  it("gives no name to files that cannot be imported by name", () => {
    expect(moduleNameFor("my-app/main.py", [""])).toBeUndefined();
    expect(moduleNameFor("pkg/1st.py", [""])).toBeUndefined();
    expect(moduleNameFor("readme.txt", [""])).toBeUndefined();
  });

  it("accepts Windows-style separators by normalising them", () => {
    expect(moduleNameFor("src\\shop\\models.py", ["", "src"])).toBe("shop.models");
  });
});

describe("computeProjectInfo", () => {
  it("builds both maps, packages (including namespace packages) and internal top-levels", () => {
    const info = computeProjectInfo(
      ["src/shop/__init__.py", "src/shop/utils/helpers.py", "tests/test_a.py"],
      ["src"],
    );
    expect(info.moduleToFile).toEqual({
      shop: "src/shop/__init__.py",
      "shop.utils.helpers": "src/shop/utils/helpers.py",
      "tests.test_a": "tests/test_a.py",
    });
    expect(info.fileToModule["src/shop/utils/helpers.py"]).toBe("shop.utils.helpers");
    // `shop.utils` has no __init__.py: it is an implicit namespace package.
    expect(info.packages).toEqual(["shop", "shop.utils", "tests"]);
    expect(info.internalTopLevel).toEqual(["shop", "tests"]);
    expect(info.roots).toEqual(["", "src"]);
  });

  it("normalises Windows-style input paths", () => {
    const info = computeProjectInfo(["src\\shop\\a.py"], ["src"]);
    expect(info.moduleToFile).toEqual({ "shop.a": "src/shop/a.py" });
  });

  it("lets a package win over a module with the same name", () => {
    const info = computeProjectInfo(["a.py", "a/__init__.py"], [""]);
    expect(info.moduleToFile.a).toBe("a/__init__.py");
    expect(info.fileToModule["a.py"]).toBe("a");
  });

  it("supports several roots", () => {
    const info = computeProjectInfo(
      ["libs/core/core/x.py", "apps/web/web/y.py"],
      ["libs/core", "apps/web"],
    );
    expect(info.moduleToFile).toEqual({
      "core.x": "libs/core/core/x.py",
      "web.y": "apps/web/web/y.py",
    });
  });

  it("is deterministic regardless of input order", () => {
    const files = ["b/x.py", "a/y.py", "a/__init__.py"];
    expect(computeProjectInfo([...files].reverse(), [""])).toEqual(computeProjectInfo(files, [""]));
  });

  it("round-trips through readProjectInfo and rejects malformed data", () => {
    const info = computeProjectInfo(["src/shop/a.py"], ["src"]);
    const table = readProjectInfo(JSON.parse(JSON.stringify(info)));
    expect(table?.moduleToFile.get("shop.a")).toBe("src/shop/a.py");
    expect(table?.internalTopLevel.has("shop")).toBe(true);
    expect(readProjectInfo({})).toBeUndefined();
    expect(readProjectInfo({ ...info, roots: "src" })).toBeUndefined();
    expect(readProjectInfo(null)).toBeUndefined();
  });

  it("records main packages that match a project name", () => {
    const info = computeProjectInfo(["src/my_app/a.py", "src/other/b.py"], ["src"], ["My-App"]);
    expect(info.mainPackages).toEqual(["my_app"]);
  });
});

describe("inferConventionalRoots", () => {
  it("takes the parent of the topmost package directory", () => {
    expect(
      inferConventionalRoots([
        "lib/pkg/__init__.py",
        "lib/pkg/sub/__init__.py",
        "lib/pkg/sub/m.py",
      ]),
    ).toEqual(["lib"]);
  });

  it("ignores a root-level __init__.py and gives the repo root for top-level packages", () => {
    expect(inferConventionalRoots(["__init__.py", "app/__init__.py"])).toEqual([""]);
  });
});

describe("pythonPrepare", () => {
  it("uses the repo root and src/ without any manifest", async () => {
    const info = await pythonPrepare(
      projectContext(py("src/shop/__init__.py", "src/shop/a.py", "scripts/seed.py")),
    );
    expect(info.roots).toEqual(["", "src"]);
    expect(info.moduleToFile["shop.a"]).toBe("src/shop/a.py");
    expect(info.moduleToFile["scripts.seed"]).toBe("scripts/seed.py");
  });

  it("finds roots from setuptools find.where", async () => {
    const info = await pythonPrepare(
      projectContext({
        ...py("python/pkg/__init__.py", "python/pkg/a.py"),
        "pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["python"]\n',
      }),
    );
    expect(info.roots).toContain("python");
    expect(info.moduleToFile["pkg.a"]).toBe("python/pkg/a.py");
  });

  it("finds roots from setuptools package-dir (both forms)", async () => {
    const empty = await pythonPrepare(
      projectContext({
        ...py("lib/pkg/a.py"),
        "pyproject.toml": '[tool.setuptools.package-dir]\n"" = "lib"\n',
      }),
    );
    expect(empty.moduleToFile["pkg.a"]).toBe("lib/pkg/a.py");

    const named = await pythonPrepare(
      projectContext({
        ...py("vendor/thing/a.py"),
        "pyproject.toml": '[tool.setuptools.package-dir]\nthing = "vendor/thing"\n',
      }),
    );
    expect(named.roots).toContain("vendor");
    expect(named.moduleToFile["thing.a"]).toBe("vendor/thing/a.py");
  });

  it("finds roots from poetry packages with `from`", async () => {
    const info = await pythonPrepare(
      projectContext({
        ...py("backend/api/a.py"),
        "pyproject.toml":
          '[tool.poetry]\nname = "api"\npackages = [{ include = "api", from = "backend" }]\n',
      }),
    );
    expect(info.roots).toContain("backend");
    expect(info.mainPackages).toEqual(["api"]);
  });

  it("finds roots from hatch wheel packages and pdm package-dir", async () => {
    const hatch = await pythonPrepare(
      projectContext({
        ...py("code/hpkg/a.py"),
        "pyproject.toml": '[tool.hatch.build.targets.wheel]\npackages = ["code/hpkg"]\n',
      }),
    );
    expect(hatch.roots).toContain("code");
    const pdm = await pythonPrepare(
      projectContext({
        ...py("source/ppkg/a.py"),
        "pyproject.toml": '[tool.pdm.build]\npackage-dir = "source"\n',
      }),
    );
    expect(pdm.roots).toContain("source");
  });

  it("reads [project] name for the main package", async () => {
    const info = await pythonPrepare(
      projectContext({
        ...py("src/shop/a.py"),
        "pyproject.toml": '[project]\nname = "shop"\n',
      }),
    );
    expect(info.mainPackages).toEqual(["shop"]);
  });

  it("reads setup.cfg package_dir and find.where", async () => {
    const cfg = await pythonPrepare(
      projectContext({
        ...py("lib/cpkg/a.py", "other/opkg/b.py"),
        "setup.cfg":
          "[options]\npackage_dir =\n    =lib\n\n[options.packages.find]\nwhere = other\n",
      }),
    );
    expect(cfg.moduleToFile["cpkg.a"]).toBe("lib/cpkg/a.py");
    expect(cfg.moduleToFile["opkg.b"]).toBe("other/opkg/b.py");
  });

  it("reads nested manifests relative to their directory", async () => {
    const info = await pythonPrepare(
      projectContext({
        ...py("services/billing/src/billing/a.py"),
        "services/billing/pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["src"]\n',
      }),
    );
    expect(info.roots).toContain("services/billing/src");
    expect(info.moduleToFile["billing.a"]).toBe("services/billing/src/billing/a.py");
  });

  it("ignores manifest directories that do not exist or escape the repo", async () => {
    const info = await pythonPrepare(
      projectContext({
        ...py("a.py"),
        "pyproject.toml":
          '[tool.setuptools.packages.find]\nwhere = ["nope", "../outside", "/abs"]\n',
      }),
    );
    expect(info.roots).toEqual([""]);
  });

  it("never throws on malformed manifests", async () => {
    const info = await pythonPrepare(
      projectContext({
        ...py("src/shop/a.py"),
        "pyproject.toml": "[tool.setuptools\nwhere = [",
        "setup.cfg": "\u0000[[[",
      }),
    );
    expect(info.moduleToFile["shop.a"]).toBe("src/shop/a.py");
  });

  it("supports namespace packages (no __init__.py)", async () => {
    const info = await pythonPrepare(projectContext(py("ns/sub/mod.py")));
    expect(info.moduleToFile["ns.sub.mod"]).toBe("ns/sub/mod.py");
    expect(info.packages).toEqual(["ns", "ns.sub"]);
  });

  it("returns something useful when the repo view throws", async () => {
    const ctx = projectContext(py("src/a/b.py"));
    const broken = {
      ...ctx,
      repo: {
        ...ctx.repo,
        isDir: () => {
          throw new Error("boom");
        },
      },
    };
    const info = await pythonPrepare(broken);
    expect(info.moduleToFile["src.a.b"]).toBe("src/a/b.py");
  });
});

describe("readPyproject / readSetupCfg", () => {
  it("returns no roots for empty or broken text", () => {
    expect(readPyproject("", "")).toEqual({ roots: [], projectNames: [] });
    expect(readPyproject("[[[", "")).toEqual({ roots: [], projectNames: [] });
    expect(readSetupCfg("", "")).toEqual({ roots: [], projectNames: [] });
  });
});

describe("stdlib list", () => {
  it("is complete enough and classifies top-level names", () => {
    expect(PYTHON_STDLIB_MODULES.size).toBeGreaterThan(190);
    for (const name of ["os", "sys", "re", "json", "typing", "pathlib", "asyncio", "unittest"]) {
      expect(isStdlibModule(name)).toBe(true);
    }
    expect(isStdlibModule("requests")).toBe(false);
    expect(isStdlibModule("os.path")).toBe(false);
  });
});
