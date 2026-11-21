import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, SourceResponse } from "../../api/types.ts";
import { makeAnalysis, mockFetch, renderApp } from "../../test/utils.tsx";
import { CodePanel } from "./code-panel.tsx";

// Real Shiki is covered in lib/shiki.test.ts; here highlighting returns plain tokens.
vi.mock("../../lib/shiki.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/shiki.ts")>();
  return { ...original, highlightCode: async (code: string) => original.plainLines(code) };
});

const FN: GraphNode = {
  id: "sym:src/a.ts#run",
  kind: "function",
  name: "run",
  file: "src/a.ts",
  language: "typescript",
  span: { startLine: 20, endLine: 22 },
};
const FILE: GraphNode = {
  id: "file:src/a.ts",
  kind: "file",
  name: "a.ts",
  file: "src/a.ts",
  language: "typescript",
};

const analysis = makeAnalysis({ commitSha: "abc123" });

function sourceFor(start: number, end: number, total = 100): SourceResponse {
  const lines: string[] = [];
  for (let n = start; n <= end; n++)
    lines.push(n === 20 ? "function run() {<b>x</b>" : `line ${n}`);
  return {
    file: "src/a.ts",
    language: "typescript",
    startLine: start,
    endLine: end,
    totalLines: total,
    content: lines.join("\n"),
  };
}

/** Serves /node and /source; remembers the source query so tests can check the range. */
function serve(node: GraphNode, source?: (start: number, end: number) => unknown) {
  const sourceCalls: URLSearchParams[] = [];
  mockFetch((url) => {
    if (url.includes("/node")) {
      return {
        status: 200,
        body: {
          node,
          parents: [],
          children: [],
          counts: { callers: 0, callees: 0, importedBy: 0, imports: 0 },
        },
      };
    }
    const query = new URLSearchParams(url.slice(url.indexOf("?")));
    sourceCalls.push(query);
    const start = Number(query.get("start") ?? 1);
    const end = Number(query.get("end") ?? 100);
    if (source) {
      const body = source(start, end);
      if (body !== undefined) return { status: 200, body };
    }
    return { status: 200, body: sourceFor(start, Math.min(end, 100)) };
  });
  return sourceCalls;
}

function renderPanel(route: string, onClose?: () => void) {
  return renderApp(<CodePanel analysisId="an_1" analysis={analysis} onClose={onClose} />, {
    route,
    path: "/a/:analysisId",
  });
}

beforeEach(() => {
  // jsdom has no layout; the panel scrolls by setting scrollTop, which is harmless here.
  document.documentElement.classList.remove("dark");
});
afterEach(() => vi.unstubAllGlobals());

describe("CodePanel", () => {
  it("asks to select something when there is no node", () => {
    mockFetch(() => ({ status: 500, body: {} }));
    renderPanel("/a/an_1");
    expect(screen.getByText("No code to show")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });

  it("loads the span plus 5 lines of context and numbers lines from the real start", async () => {
    const calls = serve(FN);
    renderPanel("/a/an_1?node=sym:src/a.ts%23run");
    const lines = await screen.findByTestId("code-lines");
    expect(calls[0]?.get("file")).toBe("src/a.ts");
    expect(calls[0]?.get("start")).toBe("15");
    expect(calls[0]?.get("end")).toBe("27");
    expect(lines.querySelector('[data-line="15"]')).not.toBeNull();
    expect(lines.querySelector('[data-line="14"]')).toBeNull();
    expect(lines.querySelectorAll("[data-selected]")).toHaveLength(3);
    expect(lines.querySelector('[data-line="20"]')).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("lines 15–27 of 100 · typescript")).toBeInTheDocument();
  });

  it("renders source text as text, never as HTML", async () => {
    serve(FN);
    renderPanel("/a/an_1?node=sym:src/a.ts%23run");
    const lines = await screen.findByTestId("code-lines");
    expect(lines).toHaveTextContent("function run() {<b>x</b>");
    expect(lines.querySelector("b")).toBeNull();
  });

  it("highlights and scrolls to a call site in the loaded file", async () => {
    serve(FN);
    renderPanel("/a/an_1?node=sym:src/a.ts%23run&hl=src/a.ts@21");
    const lines = await screen.findByTestId("code-lines");
    expect(lines.querySelector('[data-line="21"]')).toHaveAttribute("data-callsite", "true");
    expect(lines.querySelectorAll("[data-callsite]")).toHaveLength(1);
    const link = screen.getByRole("link", { name: "Open on GitHub" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/blob/abc123/src/a.ts#L21",
    );
  });

  it("ignores a call site that belongs to another file", async () => {
    serve(FN);
    renderPanel("/a/an_1?node=sym:src/a.ts%23run&hl=src/other.ts@21");
    const lines = await screen.findByTestId("code-lines");
    expect(lines.querySelectorAll("[data-callsite]")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/blob/abc123/src/a.ts#L20-L22",
    );
  });

  it("shows a notice when a whole file is cut short", async () => {
    serve(FILE, (start, end) => sourceFor(start, end, 5000));
    renderPanel("/a/an_1?node=file:src/a.ts");
    expect(await screen.findByRole("note", {}, { timeout: 5000 })).toHaveTextContent("of 5000");
  });

  it("shows empty and binary files", async () => {
    serve(FILE, () => ({
      ...sourceFor(1, 1),
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      content: "",
    }));
    renderPanel("/a/an_1?node=file:src/a.ts");
    expect(await screen.findByText("This file is empty")).toBeInTheDocument();
  });

  it("shows a binary notice", async () => {
    serve(FILE, () => ({ ...sourceFor(1, 1), content: "a\0b" }));
    renderPanel("/a/an_1?node=file:src/a.ts");
    expect(await screen.findByText("Binary file")).toBeInTheDocument();
    expect(screen.queryByTestId("code-lines")).toBeNull();
  });

  it("shows FILE_NOT_FOUND as an unavailable source", async () => {
    mockFetch((url) =>
      url.includes("/node")
        ? {
            status: 200,
            body: {
              node: FILE,
              parents: [],
              children: [],
              counts: { callers: 0, callees: 0, importedBy: 0, imports: 0 },
            },
          }
        : { status: 404, body: { error: { code: "FILE_NOT_FOUND", message: "nope" } } },
    );
    renderPanel("/a/an_1?node=file:src/a.ts");
    expect(await screen.findByText("Source not available")).toBeInTheDocument();
  });

  it("explains that directories have no source", async () => {
    serve({ id: "dir:src", kind: "directory", name: "src" });
    renderPanel("/a/an_1?node=dir:src");
    expect(await screen.findByText("This item has no source file")).toBeInTheDocument();
  });

  it("copies the code and announces it", async () => {
    serve(FN);
    const user = userEvent.setup();
    // user-event installs its own clipboard stub; spy on it after setup.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderPanel("/a/an_1?node=sym:src/a.ts%23run");
    await screen.findByTestId("code-lines");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("line 15");
    expect(await screen.findByText("Copied to clipboard")).toBeInTheDocument();
  });

  it("toggles full screen, exits with Escape and returns focus to the button", async () => {
    serve(FN);
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel("/a/an_1?node=sym:src/a.ts%23run", onClose);
    await screen.findByTestId("code-lines");
    const toggle = screen.getByRole("button", { name: "Full screen" });
    await user.click(toggle);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Exit full screen" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Full screen" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose from the Close button", async () => {
    serve(FN);
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel("/a/an_1?node=sym:src/a.ts%23run", onClose);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
