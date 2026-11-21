// The user's own recent analyses, kept in localStorage so they survive reloads.
// Anything read back is validated: the stored text may be old, edited, or corrupted.
import { AnalysisStatusSchema } from "@repoatlas/schema";
import type { AnalysisStatus } from "../api/types.ts";
import { readStorage, writeStorage } from "./storage.ts";

export const RECENT_STORAGE_KEY = "repoatlas.recent";
export const MAX_RECENT = 20;

export interface RecentEntry {
  id: string;
  /** "owner/repo" */
  repo: string;
  ref: string;
  /** ISO 8601 date the analysis was started from this browser. */
  date: string;
  status: AnalysisStatus;
}

function toEntry(value: unknown): RecentEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const status = AnalysisStatusSchema.safeParse(v.status);
  if (
    typeof v.id !== "string" ||
    v.id === "" ||
    typeof v.repo !== "string" ||
    typeof v.ref !== "string" ||
    typeof v.date !== "string" ||
    !status.success
  ) {
    return undefined;
  }
  return { id: v.id, repo: v.repo, ref: v.ref, date: v.date, status: status.data };
}

/** Returns the stored entries, newest first. Corrupted data yields an empty list. */
export function readRecent(): RecentEntry[] {
  const raw = readStorage(RECENT_STORAGE_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: RecentEntry[] = [];
  for (const item of parsed) {
    const entry = toEntry(item);
    if (entry) entries.push(entry);
  }
  return entries.slice(0, MAX_RECENT);
}

function save(entries: RecentEntry[]): void {
  writeStorage(RECENT_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
}

/** Adds an entry at the top; an existing entry with the same id is replaced (dedupe). */
export function addRecent(entry: RecentEntry): RecentEntry[] {
  const next = [entry, ...readRecent().filter((e) => e.id !== entry.id)].slice(0, MAX_RECENT);
  save(next);
  return next;
}

/** Updates the status of an existing entry; does nothing when it is not in the list. */
export function updateRecentStatus(id: string, status: AnalysisStatus): RecentEntry[] {
  const current = readRecent();
  const existing = current.find((e) => e.id === id);
  if (!existing || existing.status === status) return current;
  const next = current.map((e) => (e.id === id ? { ...e, status } : e));
  save(next);
  return next;
}
