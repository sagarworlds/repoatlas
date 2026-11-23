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

  it("supports TypeScript, JavaScript, Python, Go and Java", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["typescript", "javascript", "python", "go", "java"]);
    expect(isLanguageSupported("go")).toBe(true);
    expect(isLanguageSupported("kotlin")).toBe(false);
  });

  it("enables examples from the same config", () => {
    for (const id of ["python", "go", "java", "javascript"] as const) {
      const example = EXAMPLES.find((e) => e.language === id);
      expect(example && isExampleAvailable(example)).toBe(true);
    }
  });
});
