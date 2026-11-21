// The URL query string is the single source of truth for explorer state (docs/UI.md), so
// links are shareable and Back/Forward work. Every explorer component reads and writes
// state ONLY through useExplorerParams(). Parameter names are a fixed contract.
import { CONFIDENCES, EDGE_KINDS } from "@repoatlas/schema";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Confidence, DepsDirection, EdgeKind, GraphLevel } from "../api/types.ts";

export type ExplorerTab = "map" | "flow" | "deps";

export interface ExplorerParams {
  tab: ExplorerTab;
  /** Selected node id. */
  node: string | undefined;
  /** Center file path of the dependencies tab. */
  file: string | undefined;
  /** Map root node id. */
  root: string;
  level: GraphLevel;
  kinds: EdgeKind[];
  conf: Confidence;
  tests: boolean;
  ext: boolean;
  /** Map depth 1-5 (default 2) or, on the deps tab, dependency depth 1-3 (default 1). */
  depth: number;
  /** Call flow depth towards callers, 0-4. */
  up: number;
  /** Call flow depth towards callees, 0-4. */
  down: number;
  dir: DepsDirection;
  /** Call-site highlight as "path@line", e.g. "src/a.ts@42". */
  hl: string | undefined;
}

export const TABS: readonly ExplorerTab[] = ["map", "flow", "deps"];
const LEVELS: readonly GraphLevel[] = ["dir", "file", "symbol"];
const DIRECTIONS: readonly DepsDirection[] = ["imports", "importedBy", "both"];
/** `contains` is expressed through parent ids, never as an edge kind to request. */
const SELECTABLE_EDGE_KINDS: readonly EdgeKind[] = EDGE_KINDS.filter((k) => k !== "contains");

export const DEFAULT_KINDS: readonly EdgeKind[] = ["imports", "calls"];
const MAX_TEXT_LENGTH = 1000;

/** Default `depth` depends on the tab (different ranges for the map and for dependencies). */
export function defaultDepth(tab: ExplorerTab): number {
  return tab === "deps" ? 1 : 2;
}
function depthRange(tab: ExplorerTab): { min: number; max: number } {
  return tab === "deps" ? { min: 1, max: 3 } : { min: 1, max: 5 };
}

export const DEFAULT_PARAMS: ExplorerParams = {
  tab: "map",
  node: undefined,
  file: undefined,
  root: "dir:",
  level: "dir",
  kinds: [...DEFAULT_KINDS],
  conf: "name-match",
  tests: false,
  ext: false,
  depth: 2,
  up: 1,
  down: 2,
  dir: "both",
  hl: undefined,
};

// ---------------------------------------------------------------------------
// Parsing helpers: anything invalid falls back to the default instead of throwing.
// ---------------------------------------------------------------------------

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/** Non-empty text without control characters and of sane length; otherwise undefined. */
function cleanText(value: string | null): string | undefined {
  if (value === null || value === "" || value.length > MAX_TEXT_LENGTH) return undefined;
  return hasControlChars(value) ? undefined : value;
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || !/^-?\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number.parseInt(value, 10)));
}

function parseFlag(value: string | null, fallback: boolean): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  return fallback;
}

function parseKinds(value: string | null): EdgeKind[] {
  if (value === null) return [...DEFAULT_KINDS];
  const wanted = new Set(value.split(","));
  // Canonical order, no duplicates, unknown values dropped.
  const kinds = SELECTABLE_EDGE_KINDS.filter((k) => wanted.has(k));
  return kinds.length > 0 ? kinds : [...DEFAULT_KINDS];
}

const HIGHLIGHT_RE = /^(.+)@(\d+)$/;

/** Encodes a call-site highlight as "path@line". */
export function encodeHighlight(file: string, line: number): string {
  return `${file}@${line}`;
}

/** Decodes "path@line"; undefined when malformed. */
export function decodeHighlight(
  hl: string | undefined,
): { file: string; line: number } | undefined {
  if (hl === undefined) return undefined;
  const match = HIGHLIGHT_RE.exec(hl);
  if (!match) return undefined;
  const line = Number.parseInt(match[2] ?? "", 10);
  const file = match[1];
  return file !== undefined && line >= 1 ? { file, line } : undefined;
}

/** Reads and validates the explorer state from a query string. Never throws. */
export function parseExplorerParams(searchParams: URLSearchParams): ExplorerParams {
  const tab = oneOf(searchParams.get("tab"), TABS, "map");
  const range = depthRange(tab);
  const hl = cleanText(searchParams.get("hl"));
  return {
    tab,
    node: cleanText(searchParams.get("node")),
    file: cleanText(searchParams.get("file")),
    root: cleanText(searchParams.get("root")) ?? DEFAULT_PARAMS.root,
    level: oneOf(searchParams.get("level"), LEVELS, DEFAULT_PARAMS.level),
    kinds: parseKinds(searchParams.get("kinds")),
    conf: oneOf(searchParams.get("conf"), CONFIDENCES, DEFAULT_PARAMS.conf),
    tests: parseFlag(searchParams.get("tests"), DEFAULT_PARAMS.tests),
    ext: parseFlag(searchParams.get("ext"), DEFAULT_PARAMS.ext),
    depth: clampInt(searchParams.get("depth"), range.min, range.max, defaultDepth(tab)),
    up: clampInt(searchParams.get("up"), 0, 4, DEFAULT_PARAMS.up),
    down: clampInt(searchParams.get("down"), 0, 4, DEFAULT_PARAMS.down),
    dir: oneOf(searchParams.get("dir"), DIRECTIONS, DEFAULT_PARAMS.dir),
    hl: decodeHighlight(hl) ? hl : undefined,
  };
}

function sameKinds(a: readonly EdgeKind[], b: readonly EdgeKind[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}

/** Names of every query parameter owned by the explorer (others are left alone). */
export const EXPLORER_PARAM_NAMES = [
  "tab",
  "node",
  "file",
  "root",
  "level",
  "kinds",
  "conf",
  "tests",
  "ext",
  "depth",
  "up",
  "down",
  "dir",
  "hl",
] as const;

/** Builds a query string, leaving out every value that equals its default (short URLs). */
export function serializeExplorerParams(params: ExplorerParams): URLSearchParams {
  const out = new URLSearchParams();
  const d = DEFAULT_PARAMS;
  if (params.tab !== d.tab) out.set("tab", params.tab);
  if (params.node !== undefined) out.set("node", params.node);
  if (params.file !== undefined) out.set("file", params.file);
  if (params.root !== d.root) out.set("root", params.root);
  if (params.level !== d.level) out.set("level", params.level);
  if (!sameKinds(params.kinds, d.kinds)) {
    const ordered = SELECTABLE_EDGE_KINDS.filter((k) => params.kinds.includes(k));
    if (ordered.length > 0) out.set("kinds", ordered.join(","));
  }
  if (params.conf !== d.conf) out.set("conf", params.conf);
  if (params.tests !== d.tests) out.set("tests", params.tests ? "1" : "0");
  if (params.ext !== d.ext) out.set("ext", params.ext ? "1" : "0");
  if (params.depth !== defaultDepth(params.tab)) out.set("depth", String(params.depth));
  if (params.up !== d.up) out.set("up", String(params.up));
  if (params.down !== d.down) out.set("down", String(params.down));
  if (params.dir !== d.dir) out.set("dir", params.dir);
  if (params.hl !== undefined) out.set("hl", params.hl);
  return out;
}

export interface SetParamsOptions {
  /** Add a history entry (Back returns to the previous state). Default: replace. */
  push?: boolean;
}

export interface UseExplorerParamsResult {
  params: ExplorerParams;
  /** Merges `patch` into the current state. Use `{ node: undefined }` to clear a value. */
  setParams: (patch: Partial<ExplorerParams>, options?: SetParamsOptions) => void;
}

/**
 * Applies a patch: when only the tab changes, `depth` resets to the new tab's default
 * (map and deps use different depth ranges). Pure, exported for tests.
 */
export function applyPatch(
  current: ExplorerParams,
  patch: Partial<ExplorerParams>,
): ExplorerParams {
  const next: ExplorerParams = { ...current, ...patch };
  // A new selection must not keep the previous selection's deps centre or call-site highlight.
  // A patch that sets `file` or `hl` explicitly (even to undefined) is respected.
  if ("node" in patch && patch.node !== current.node) {
    if (!("file" in patch)) next.file = undefined;
    if (!("hl" in patch)) next.hl = undefined;
  }
  if (patch.tab !== undefined && patch.tab !== current.tab && patch.depth === undefined) {
    next.depth = defaultDepth(next.tab);
  }
  // Re-validate through the parser so callers can never write an out-of-range value.
  return parseExplorerParams(serializeExplorerParams(next));
}

/** Explorer state stored in the URL. Like a typed view over the query string. */
export function useExplorerParams(): UseExplorerParamsResult {
  const [searchParams, setSearchParams] = useSearchParams();
  // useMemo caches the parsed object until the query string changes.
  const params = useMemo(() => parseExplorerParams(searchParams), [searchParams]);

  const setParams = useCallback(
    (patch: Partial<ExplorerParams>, options?: SetParamsOptions) => {
      const next = serializeExplorerParams(applyPatch(params, patch));
      // Keep query parameters that are not ours.
      for (const [key, value] of searchParams) {
        if (!(EXPLORER_PARAM_NAMES as readonly string[]).includes(key)) next.append(key, value);
      }
      setSearchParams(next, { replace: !options?.push });
    },
    [params, searchParams, setSearchParams],
  );

  return { params, setParams };
}
