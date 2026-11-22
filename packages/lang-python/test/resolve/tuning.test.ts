import type { FileExtraction, GraphEdge } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { extractPython } from "../../src/extract/index.ts";
import { run, sym } from "./helpers.ts";

/** Extracts real Python sources, then resolves them together. */
async function analyse(files: Record<string, string>) {
  const extractions: FileExtraction[] = [];
  for (const [path, content] of Object.entries(files)) {
    extractions.push(await extractPython({ path, content }));
  }
  return run(extractions, {}, files);
}

function edge(edges: GraphEdge[], src: string, dst: string): GraphEdge | undefined {
  return edges.find((e) => e.kind === "calls" && e.src === src && e.dst === dst);
}

describe("stdlib modules shadowed by a namespace directory", () => {
  it("treats `import typing` as external even when tests/typing/ exists", async () => {
    const { result, summary } = await analyse({
      "tests/typing/example.py": "def check(): pass\n",
      "app.py":
        "import typing as t\nfrom typing import cast\n\ndef f(x):\n    return t.cast(int, cast(int, x))\n",
    });
    expect(result.unresolved).toEqual([]);
    expect(result.edges.filter((e) => e.kind === "calls")).toEqual([]);
    expect(summary.byReason.external).toBeGreaterThan(0);
  });

  it("keeps a real module below a namespace directory internal", async () => {
    const { result } = await analyse({
      "typing/helpers.py": "def go(): pass\n",
      "app.py": "from typing.helpers import go\n\ndef f():\n    go()\n",
    });
    expect(edge(result.edges, sym("app.py", "f"), sym("typing/helpers.py", "go"))).toBeDefined();
  });
});

describe("dotted module chains", () => {
  const files = {
    "pkg/__init__.py": "",
    "pkg/cookies.py":
      "class Jar:\n    def set(self, k):\n        pass\n\ndef helper():\n    pass\n",
    "app.py":
      "import pkg\n\ndef f():\n    pkg.cookies.helper()\n    j = pkg.cookies.Jar()\n    j.set('a')\n",
  };

  it("resolves `pkg.cookies.helper()` after a plain `import pkg`", async () => {
    const { result } = await analyse(files);
    expect(edge(result.edges, sym("app.py", "f"), sym("pkg/cookies.py", "helper"))).toMatchObject({
      confidence: "inferred",
    });
  });

  it("resolves a dotted type hint and a stoplisted method name through it", async () => {
    const { result } = await analyse(files);
    expect(edge(result.edges, sym("app.py", "f"), sym("pkg/cookies.py", "Jar.set"))).toBeDefined();
  });

  it("follows a submodule that the package __init__ imports", async () => {
    const { result } = await analyse({
      "pkg/__init__.py": "from . import cookies\n",
      "pkg/cookies.py": "def helper():\n    pass\n",
      "app.py": "import pkg\n\ndef f():\n    pkg.cookies.helper()\n",
    });
    expect(edge(result.edges, sym("app.py", "f"), sym("pkg/cookies.py", "helper"))).toBeDefined();
  });
});

describe("calls through parameters", () => {
  it("makes no edge and no unresolved entry for `callback()` of a parameter", async () => {
    const { result } = await analyse({
      "a.py": "def callback():\n    pass\n",
      "b.py":
        "def run(callback):\n    callback()\n\ndef outer(hook):\n    def inner():\n        hook()\n    return inner\n",
    });
    expect(result.edges.filter((e) => e.kind === "calls")).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("still resolves a call when the name is not a parameter", async () => {
    const { result } = await analyse({
      "a.py": "def callback():\n    pass\n",
      "b.py": "from a import callback\n\ndef run(other):\n    callback()\n",
    });
    expect(edge(result.edges, sym("b.py", "run"), sym("a.py", "callback"))).toBeDefined();
  });
});

describe("instance attribute types", () => {
  const client = "class Client:\n    def send(self):\n        pass\n";

  it("types `self.x.m()` from `self.x = Foo()` in __init__", async () => {
    const { result } = await analyse({
      "net.py": client,
      "svc.py":
        "from net import Client\n\nclass Service:\n    def __init__(self):\n        self.client = Client()\n\n    def go(self):\n        self.client.send()\n",
    });
    expect(
      edge(result.edges, sym("svc.py", "Service.go"), sym("net.py", "Client.send")),
    ).toMatchObject({ confidence: "inferred" });
  });

  it("types it from an annotated constructor parameter", async () => {
    const { result } = await analyse({
      "net.py": client,
      "svc.py":
        "from net import Client\n\nclass Service:\n    def __init__(self, c: Client):\n        self.c = c\n\n    def go(self):\n        self.c.send()\n",
    });
    expect(
      edge(result.edges, sym("svc.py", "Service.go"), sym("net.py", "Client.send")),
    ).toBeDefined();
  });

  it("ignores `self.x = None` next to the real assignment", async () => {
    const { result } = await analyse({
      "net.py": client,
      "svc.py":
        "from net import Client\n\nclass Service:\n    def __init__(self):\n        self.client = None\n\n    def open(self):\n        self.client = Client()\n\n    def go(self):\n        self.client.send()\n",
    });
    expect(
      edge(result.edges, sym("svc.py", "Service.go"), sym("net.py", "Client.send")),
    ).toBeDefined();
  });

  it("gives no type when two assignments disagree", async () => {
    const { result } = await analyse({
      "net.py": `${client}\nclass Other:\n    def send(self):\n        pass\n`,
      "svc.py":
        "from net import Client, Other\n\nclass Service:\n    def __init__(self, flag):\n        if flag:\n            self.c = Client()\n        else:\n            self.c = Other()\n\n    def go(self):\n        self.c.send()\n",
    });
    const edges = result.edges.filter(
      (e) => e.kind === "calls" && e.src === sym("svc.py", "Service.go"),
    );
    // Two classes define send(): the match is by name only, never "inferred".
    expect(edges.every((e) => e.confidence === "name-match")).toBe(true);
  });

  it("types the receiver of a constructor call: `Client().send()`", async () => {
    const { result } = await analyse({
      "net.py": client,
      "app.py": "from net import Client\n\ndef f():\n    Client().send()\n",
    });
    expect(edge(result.edges, sym("app.py", "f"), sym("net.py", "Client.send"))).toMatchObject({
      confidence: "inferred",
    });
  });
});

describe("pytest fixtures", () => {
  const net = "class Runner:\n    def invoke(self):\n        pass\n";
  const other =
    "class Ctx:\n    def invoke(self):\n        pass\n\nclass Cmd:\n    def invoke(self):\n        pass\n\nclass Grp:\n    def invoke(self):\n        pass\n";

  it("types a test parameter from the conftest fixture's returned class", async () => {
    const { result } = await analyse({
      "net.py": net,
      "extra.py": other,
      "tests/conftest.py":
        "import pytest\nfrom net import Runner\n\n@pytest.fixture\ndef runner():\n    return Runner()\n",
      "tests/test_x.py": "def test_a(runner):\n    runner.invoke()\n",
    });
    expect(
      edge(result.edges, sym("tests/test_x.py", "test_a"), sym("net.py", "Runner.invoke")),
    ).toMatchObject({ confidence: "inferred" });
  });

  it("follows yield fixtures and fixtures in the same file", async () => {
    const { result } = await analyse({
      "net.py": net,
      "extra.py": other,
      "tests/test_y.py":
        "import pytest\nfrom net import Runner\n\n@pytest.fixture(scope='function')\ndef runner():\n    r = Runner()\n    yield r\n\ndef test_b(runner):\n    runner.invoke()\n",
    });
    expect(
      edge(result.edges, sym("tests/test_y.py", "test_b"), sym("net.py", "Runner.invoke")),
    ).toBeDefined();
  });

  it("uses the fixture's return annotation", async () => {
    const { result } = await analyse({
      "net.py": net,
      "extra.py": other,
      "conftest.py":
        "import pytest\nfrom net import Runner\nfrom typing import Iterator\n\n@pytest.fixture\ndef runner() -> Iterator[Runner]:\n    yield make()\n",
      "test_z.py": "def test_c(runner):\n    runner.invoke()\n",
    });
    expect(
      edge(result.edges, sym("test_z.py", "test_c"), sym("net.py", "Runner.invoke")),
    ).toBeDefined();
  });

  it("does not type a parameter that is not a fixture", async () => {
    const { result } = await analyse({
      "net.py": net,
      "extra.py": other,
      "tests/test_w.py": "def test_d(runner):\n    runner.invoke()\n",
    });
    expect(result.edges.filter((e) => e.confidence === "inferred" && e.kind === "calls")).toEqual(
      [],
    );
    expect(result.unresolved.map((u) => u.name)).toContain("invoke");
  });
});
