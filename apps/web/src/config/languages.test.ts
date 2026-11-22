import { LANGUAGE_IDS } from "@repoatlas/schema";
import { describe, expect, it } from "vitest";
import { EXAMPLES, isExampleAvailable } from "./examples.ts";
import {
  isLanguageSupported,
  LANGUAGE_INFO,
  languageName,
  SUPPORTED_LANGUAGES,
} from "./languages.ts";

describe("language config", () => {
  it("names every schema language id exactly once", () => {
    expect(LANGUAGE_INFO.map((l) => l.id).sort()).toEqual([...LANGUAGE_IDS].sort());
    expect(languageName("csharp")).toBe("C#");
    expect(languageName("cpp")).toBe("C/C++");
    expect(languageName("klingon")).toBe("klingon");
  });

  it("supports TypeScript, JavaScript and Python", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["typescript", "javascript", "python"]);
    expect(isLanguageSupported("go")).toBe(false);
  });

  it("enables examples from the same config", () => {
    const python = EXAMPLES.find((e) => e.language === "python");
    const go = EXAMPLES.find((e) => e.language === "go");
    expect(python && isExampleAvailable(python)).toBe(true);
    expect(go && isExampleAvailable(go)).toBe(false);
  });
});
