import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRecent } from "../lib/recent.ts";
import { makeAnalysis, mockFetch, renderApp } from "../test/utils.tsx";
import { HomePage } from "./home.tsx";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const startOk = {
  id: "an_new",
  status: "queued",
  owner: "pmndrs",
  repo: "zustand",
  ref: "main",
  commitSha: "a".repeat(40),
  cached: false,
};

describe("HomePage", () => {
  it("shows inline validation without calling the API", async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: { analyses: [] } }));
    renderApp(<HomePage />);
    await userEvent.type(screen.getByLabelText(/GitHub repository/i), "not a repo");
    await userEvent.click(screen.getByRole("button", { name: "Analyze repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/spaces|owner\/repo/);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(0);
  });

  it("posts the normalized url and ref, stores the recent entry and navigates", async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === "POST"
        ? { status: 202, body: startOk }
        : { status: 200, body: { analyses: [] } },
    );
    renderApp(<HomePage />, { path: "/" });
    await userEvent.type(screen.getByLabelText(/GitHub repository/i), "pmndrs/zustand");
    await userEvent.type(screen.getByLabelText(/Ref/i), "main");
    await userEvent.click(screen.getByRole("button", { name: "Analyze repository" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/a/an_new"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/analyses");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      repoUrl: "https://github.com/pmndrs/zustand",
      ref: "main",
    });
    expect(readRecent()[0]).toMatchObject({ id: "an_new", repo: "pmndrs/zustand", ref: "main" });
  });

  it("shows the server error message for REPO_NOT_FOUND", async () => {
    mockFetch((_url, init) =>
      init?.method === "POST"
        ? {
            status: 404,
            body: { error: { code: "REPO_NOT_FOUND", message: "No such repository on GitHub." } },
          }
        : { status: 200, body: { analyses: [] } },
    );
    renderApp(<HomePage />);
    await userEvent.type(screen.getByLabelText(/GitHub repository/i), "acme/missing");
    await userEvent.click(screen.getByRole("button", { name: "Analyze repository" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Repository not found");
    expect(alert).toHaveTextContent("No such repository on GitHub.");
  });

  it("marks supported languages active and planned ones as coming soon", () => {
    mockFetch(() => ({ status: 200, body: { analyses: [] } }));
    renderApp(<HomePage />, { path: "/" });
    const chips = screen.getByRole("list", { name: "Languages" });
    expect(within(chips).getByText("Python").closest("li")).not.toHaveTextContent("soon");
    expect(within(chips).getByText("Go").closest("li")).toHaveTextContent("(soon)");
    expect(screen.getByRole("button", { name: /pallets\/click/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /spf13\/cobra/ })).toBeDisabled();
  });

  it("starts an example, and disables examples of unsupported languages", async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === "POST"
        ? { status: 202, body: { ...startOk, owner: "sindresorhus", repo: "ky" } }
        : { status: 200, body: { analyses: [] } },
    );
    renderApp(<HomePage />, { path: "/" });
    expect(screen.getByRole("button", { name: /spf13\/cobra/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /sindresorhus\/ky/ }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/a/an_new"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      repoUrl: "https://github.com/sindresorhus/ky",
    });
  });

  it("lists the user's recent analyses and the global ones", async () => {
    window.localStorage.setItem(
      "repoatlas.recent",
      JSON.stringify([
        {
          id: "an_mine",
          repo: "me/mine",
          ref: "main",
          date: "2026-01-01T00:00:00Z",
          status: "done",
        },
      ]),
    );
    mockFetch(() => ({
      status: 200,
      body: { analyses: [makeAnalysis({ id: "an_g", owner: "glob", repo: "al" })] },
    }));
    renderApp(<HomePage />);
    expect(screen.getByText("me/mine")).toBeInTheDocument();
    expect(await screen.findByText("glob/al")).toBeInTheDocument();
  });

  it("ignores corrupted recent data", () => {
    window.localStorage.setItem("repoatlas.recent", "{{{");
    mockFetch(() => ({ status: 200, body: { analyses: [] } }));
    renderApp(<HomePage />);
    expect(screen.queryByText("Your recent analyses")).not.toBeInTheDocument();
  });
});
