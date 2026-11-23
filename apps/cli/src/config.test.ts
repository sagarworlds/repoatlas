import { describe, expect, it } from "vitest";
import { ConfigError, workersFromEnv } from "./config.ts";

describe("workersFromEnv", () => {
  it("is undefined (auto) when unset or empty", () => {
    expect(workersFromEnv({})).toBeUndefined();
    expect(workersFromEnv({ EXTRACT_WORKERS: "  " })).toBeUndefined();
  });

  it("reads integers from 0 to 64", () => {
    expect(workersFromEnv({ EXTRACT_WORKERS: "0" })).toBe(0);
    expect(workersFromEnv({ EXTRACT_WORKERS: "3" })).toBe(3);
  });

  it("rejects anything else with a ConfigError", () => {
    for (const bad of ["-1", "2x", "1.5", "65"]) {
      expect(() => workersFromEnv({ EXTRACT_WORKERS: bad })).toThrow(ConfigError);
    }
  });
});
