import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAnalysis, renderApp } from "../../test/utils.tsx";
import { ExplorerLayout } from "./explorer-layout.tsx";
import { nextTab } from "./explorer-tabs.tsx";

/** Pretends the viewport is narrow (or not). jsdom has no matchMedia. */
function mockNarrow(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: narrow && query.includes("max-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderLayout(route = "/a/an_1") {
  return renderApp(
    <ExplorerLayout
      analysis={makeAnalysis()}
      search={<input aria-label="stub search" />}
      tree={<button type="button">tree item</button>}
      canvas={<div>canvas content</div>}
      detail={<div>detail content</div>}
      code={({ onClose }) => (
        <button type="button" onClick={onClose}>
          code content
        </button>
      )}
    />,
    { route, path: "/a/:analysisId" },
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("nextTab", () => {
  it("handles arrows with wrap-around, Home and End", () => {
    expect(nextTab("map", "ArrowRight")).toBe("flow");
    expect(nextTab("map", "ArrowLeft")).toBe("deps");
    expect(nextTab("deps", "ArrowRight")).toBe("map");
    expect(nextTab("flow", "Home")).toBe("map");
    expect(nextTab("map", "End")).toBe("deps");
    expect(nextTab("map", "x")).toBeUndefined();
  });
});

describe("ExplorerLayout (desktop)", () => {
  it("shows all panels, tab semantics and sets the page title", () => {
    mockNarrow(false);
    renderLayout();
    expect(screen.getByText("tree item")).toBeInTheDocument();
    expect(screen.getByText("detail content")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Views" })).toBeInTheDocument();
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected).toHaveTextContent("Map");
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Call flow" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-map");
    expect(document.title).toBe("acme/widgets - RepoAtlas");
    expect(screen.getByRole("link", { name: "0123456" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/commit/0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("moves between tabs with the arrow keys (roving focus)", async () => {
    mockNarrow(false);
    renderLayout();
    screen.getByRole("tab", { name: "Map" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Call flow" })).toHaveFocus();
    expect(screen.getByTestId("location")).toHaveTextContent("tab=flow");
  });

  it("resizes the code panel with the keyboard and persists the size", async () => {
    mockNarrow(false);
    renderLayout();
    const handle = screen.getByRole("separator");
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    expect(window.localStorage.getItem("repoatlas.layout")).toContain("codeHeight");
  });

  it("has landmarks and a skip link that focuses the canvas", async () => {
    mockNarrow(false);
    renderLayout();
    expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip to canvas" }));
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });
});

describe("ExplorerLayout (narrow)", () => {
  it("hides tree and detail until their buttons open a modal drawer", async () => {
    mockNarrow(true);
    renderLayout();
    expect(screen.queryByText("tree item")).not.toBeInTheDocument();
    expect(screen.queryByText("detail content")).not.toBeInTheDocument();

    const filesButton = screen.getByRole("button", { name: /Files/ });
    await userEvent.click(filesButton);
    const dialog = screen.getByRole("dialog", { name: "File tree" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(filesButton).toHaveFocus();
  });

  it("traps Tab inside the drawer", async () => {
    mockNarrow(true);
    renderLayout();
    await userEvent.click(screen.getByRole("button", { name: /Files/ }));
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("offers View code only with a selection and opens a full-screen sheet", async () => {
    mockNarrow(true);
    const first = renderLayout();
    expect(screen.queryByRole("button", { name: "View code" })).not.toBeInTheDocument();
    first.unmount();

    renderLayout("/a/an_1?node=sym%3Aa.ts%23f");
    await userEvent.click(screen.getByRole("button", { name: "View code" }));
    const sheet = screen.getByRole("dialog", { name: "Code" });
    await userEvent.click(within(sheet).getByRole("button", { name: "code content" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
