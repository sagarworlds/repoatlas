import type { PluginProjectInfo } from "@repoatlas/plugin-api";
import type { LanguageId } from "@repoatlas/schema";
import { z } from "zod";

/**
 * Messages between the main thread and an extraction worker. Everything here must survive
 * the structured clone algorithm (what postMessage uses): plain objects, arrays, strings,
 * Map, Set. Functions and class instances do not.
 */

/** Main -> worker: "for session N use plugin P with this prepare() info". Sent once per worker. */
export interface SessionMessage {
  type: "session";
  sessionId: number;
  pluginId: string;
  info: PluginProjectInfo;
}

/** Main -> worker: the analysis is over, forget the session. */
export interface EndSessionMessage {
  type: "end-session";
  sessionId: number;
}

/** Main -> worker: extract one file. */
export interface ExtractMessage {
  type: "extract";
  jobId: number;
  sessionId: number;
  path: string;
  bytes: number;
  content: string;
  language: LanguageId;
}

/** A discriminated union: check `type` to narrow it (like pattern matching on a C# record hierarchy). */
export type ToWorkerMessage = SessionMessage | EndSessionMessage | ExtractMessage;

/** Worker -> main replies are untrusted input, so they are validated with zod. */
export const FromWorkerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  // `extraction` is checked separately with FileExtractionSchema by the caller.
  z.object({ type: z.literal("result"), jobId: z.number().int(), extraction: z.unknown() }),
  z.object({ type: z.literal("failure"), jobId: z.number().int(), message: z.string() }),
]);

export type FromWorkerMessage = z.infer<typeof FromWorkerSchema>;
