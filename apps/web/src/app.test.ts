import { describe, expect, it } from "vitest";
import { App } from "./app.tsx";

describe("@repoatlas/web", () => {
  it("exports the App component", () => {
    expect(typeof App).toBe("function");
  });
});
