import { describe, expect, it } from "vitest";
import { isEditableTarget, matchesSearchHotkey } from "./hotkeys.ts";

function ev(key: string, extra: Partial<Parameters<typeof matchesSearchHotkey>[0]> = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: document.body as EventTarget | null,
    ...extra,
  };
}

describe("isEditableTarget", () => {
  it("is true for inputs, textareas and contenteditable, false otherwise", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isEditableTarget(div)).toBe(true);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("matchesSearchHotkey", () => {
  it("matches a bare slash outside inputs only", () => {
    expect(matchesSearchHotkey(ev("/"))).toBe(true);
    expect(matchesSearchHotkey(ev("/", { target: document.createElement("input") }))).toBe(false);
  });

  it("matches Ctrl+K and Cmd+K everywhere", () => {
    const input = document.createElement("input");
    expect(matchesSearchHotkey(ev("k", { ctrlKey: true }))).toBe(true);
    expect(matchesSearchHotkey(ev("K", { metaKey: true, target: input }))).toBe(true);
  });

  it("ignores other keys and modified variants", () => {
    expect(matchesSearchHotkey(ev("k"))).toBe(false);
    expect(matchesSearchHotkey(ev("a"))).toBe(false);
    expect(matchesSearchHotkey(ev("/", { ctrlKey: true }))).toBe(false);
    expect(matchesSearchHotkey(ev("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
