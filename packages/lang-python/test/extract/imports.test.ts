import { describe, expect, it } from "vitest";
import { extract, importOf } from "./helpers.ts";

describe("python imports", () => {
  it("handles every import form", async () => {
    const ex = await extract(`
import os.path
import sys as s, json
from shop.models import Order, User as U
from . import sibling
from .. import up
from ..pkg.sub import thing as t
from .mod import (
    a,
    b as c,
)
from pkg import *
`);
    expect(importOf(ex, "os.path")).toMatchObject({ kind: "module", isRelative: false, line: 2 });
    expect(importOf(ex, "sys")).toMatchObject({ kind: "module", alias: "s" });
    expect(importOf(ex, "json")).toMatchObject({ kind: "module" });
    expect(importOf(ex, "shop.models")).toMatchObject({
      kind: "named",
      names: [{ name: "Order" }, { name: "User", alias: "U" }],
    });
    expect(importOf(ex, ".")).toMatchObject({
      kind: "named",
      isRelative: true,
      names: [{ name: "sibling" }],
    });
    expect(importOf(ex, "..")).toMatchObject({ isRelative: true, names: [{ name: "up" }] });
    expect(importOf(ex, "..pkg.sub")).toMatchObject({
      isRelative: true,
      names: [{ name: "thing", alias: "t" }],
    });
    expect(importOf(ex, ".mod")).toMatchObject({
      names: [{ name: "a" }, { name: "b", alias: "c" }],
    });
    expect(importOf(ex, "pkg")).toMatchObject({ kind: "wildcard" });
  });

  it("skips __future__ imports", async () => {
    const ex = await extract("from __future__ import annotations\nimport os\n");
    expect(ex.imports.map((i) => i.specifier)).toEqual(["os"]);
  });

  it("finds function-level, try/except, conditional and TYPE_CHECKING imports", async () => {
    const ex = await extract(`
try:
    import ujson as json
except ImportError:
    import json
if TYPE_CHECKING:
    from shop.models import Order
def f():
    import lazy.mod
    from deferred import thing
`);
    expect(ex.imports.map((i) => i.specifier)).toEqual([
      "ujson",
      "json",
      "shop.models",
      "lazy.mod",
      "deferred",
    ]);
    expect(importOf(ex, "ujson").alias).toBe("json");
  });

  it("marks literal importlib.import_module and __import__ as dynamic", async () => {
    const ex = await extract(`
import importlib
m = importlib.import_module("plugins.csv")
n = __import__("plugins.xml")
k = importlib.import_module(name)
`);
    const dynamic = ex.imports.filter((i) => i.kind === "dynamic").map((i) => i.specifier);
    expect(dynamic).toEqual(["plugins.csv", "plugins.xml"]);
  });
});
