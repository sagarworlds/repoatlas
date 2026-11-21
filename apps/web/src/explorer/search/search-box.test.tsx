import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "../../api/types.ts";
import { makeAnalysis, renderApp } from "../../test/utils.tsx";
import { SearchBox } from "./search-box.tsx";

const RESULTS: GraphNode[] = [
  {
    id: "sym:src/a.ts#resend",
    kind: "function",
    name: "resend",
    qualifiedName: "resend",
    language: "typescript",
  },
  { id: "sym:src/b.ts#Mail", kind: "class", name: "Mail", qualifiedName: "Mail" },
  { id: "file:src/mail.ts", kind: "file", name: "mail.ts", file: "src/mail.ts" },
];

// vi.hoisted: this object must exist before the hoisted vi.mock factory below runs.
const search = vi.hoisted(() => ({
  calls: [] as { q: string; kinds: readonly string[] | undefined }[],
  error: false,
}));

vi.mock("../../api/hooks.ts", () => ({
  useSearch: (_id: string, q: string, kinds?: readonly string[]) => {
    search.calls.push({ q, kinds });
    return {
      data: q === "" || search.error ? undefined : { results: q === "zzz" ? [] : RESULTS },
      isFetching: false,
      isError: search.error && q !== "",
      error: null,
      refetch: vi.fn(),
    };
  },
}));

function setup(route = "/a/an_1") {
  const user = userEvent.setup({ delay: null });
  const view = renderApp(<SearchBox analysisId="an_1" analysis={makeAnalysis()} />, {
    route,
    path: "/a/:analysisId",
  });
  return { user, ...view };
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  search.calls.length = 0;
  search.error = false;
});
afterEach(() => vi.useRealTimers());

describe("SearchBox", () => {
  it("debounces the query by 200 ms", async () => {
    const { user } = setup();
    await user.type(screen.getByRole("combobox"), "res");
    expect(search.calls.some((c) => c.q === "res")).toBe(false);
    await advance(150);
    expect(search.calls.some((c) => c.q === "res")).toBe(false);
    await advance(100);
    expect(search.calls.some((c) => c.q === "res")).toBe(true);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("src/mail.ts")).toBeInTheDocument();
  });

  it("moves with arrows, selects with Enter and pushes node to the URL", async () => {
    const { user } = setup();
    const input = screen.getByRole("combobox");
    await user.type(input, "res");
    await advance(300);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("node=sym%3Asrc%2Fb.ts%23Mail");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("opens the flow tab for a function when clicked", async () => {
    const { user } = setup();
    await user.type(screen.getByRole("combobox"), "res");
    await advance(300);
    await user.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(screen.getByTestId("location")).toHaveTextContent("tab=flow");
  });

  it("closes on Escape", async () => {
    const { user } = setup();
    const input = screen.getByRole("combobox");
    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("opens with slash and Ctrl+K, and a slash typed inside the input stays text", async () => {
    const { user } = setup();
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("/");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
    input.blur();
    await user.keyboard("{Control>}k{/Control}");
    expect(input).toHaveFocus();
    await user.keyboard("a/b");
    expect(input).toHaveValue("a/b");
  });

  it("passes the selected kind filters to the search hook", async () => {
    const { user } = setup();
    await user.type(screen.getByRole("combobox"), "res");
    await user.click(screen.getByRole("button", { name: "Classes" }));
    expect(screen.getByRole("button", { name: /Classes/ })).toHaveAttribute("aria-pressed", "true");
    await advance(300);
    expect(search.calls.at(-1)?.kinds).toEqual(["class"]);
  });

  it("shows empty and error states", async () => {
    const { user } = setup();
    await user.type(screen.getByRole("combobox"), "zzz");
    await advance(300);
    expect(screen.getByText('No matches for "zzz".')).toBeInTheDocument();
    search.error = true;
    await user.type(screen.getByRole("combobox"), "y");
    await advance(300);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
