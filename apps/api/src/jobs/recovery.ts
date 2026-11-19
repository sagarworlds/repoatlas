import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisRecord } from "@repoatlas/store";
import { z } from "zod";

/**
 * Startup recovery design (docs/DEPLOYMENT.md section 6).
 *
 * After a restart, analyses in a non-terminal status were interrupted. Each gets ONE retry:
 *  - status `queued`: it never started, so it is simply queued again (no retry is spent);
 *  - any running status: if it was already retried once it is marked failed
 *    ("interrupted by restart"), otherwise its retry counter becomes 1 and it is queued again.
 *
 * The store has no "attempts" column, so counters live in DATA_DIR/recovery.json
 * ({ "attempts": { "<analysisId>": 1 } }). Entries for analyses that are no longer
 * non-terminal are dropped on every boot, so the file stays tiny. A missing or corrupt
 * file means "no retries spent", which is the safe direction (worst case: one extra retry).
 */
export const INTERRUPTED_MESSAGE = "Analysis was interrupted by a server restart.";

const RecoveryFileSchema = z.object({ attempts: z.record(z.string(), z.number().int().min(0)) });

export interface RecoveryPlan {
  requeue: string[];
  fail: string[];
  /** Counters to persist (only for the ids in `requeue`). */
  nextAttempts: Record<string, number>;
}

/** Pure decision function (unit tested without a database or disk). */
export function planRecovery(
  unfinished: readonly AnalysisRecord[],
  attempts: Readonly<Record<string, number>>,
): RecoveryPlan {
  const plan: RecoveryPlan = { requeue: [], fail: [], nextAttempts: {} };
  for (const record of unfinished) {
    const spent = attempts[record.id] ?? 0;
    if (record.status === "queued") {
      plan.requeue.push(record.id);
      if (spent > 0) plan.nextAttempts[record.id] = spent;
    } else if (spent >= 1) {
      plan.fail.push(record.id);
    } else {
      plan.requeue.push(record.id);
      plan.nextAttempts[record.id] = spent + 1;
    }
  }
  return plan;
}

function recoveryFile(dataDir: string): string {
  return path.join(dataDir, "recovery.json");
}

export async function readAttempts(dataDir: string): Promise<Record<string, number>> {
  try {
    const text = await readFile(recoveryFile(dataDir), "utf8");
    return RecoveryFileSchema.parse(JSON.parse(text)).attempts;
  } catch {
    return {};
  }
}

export async function writeAttempts(
  dataDir: string,
  attempts: Record<string, number>,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = recoveryFile(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ attempts }), "utf8");
  await rename(tmp, target); // replace atomically so a crash never leaves a half-written file
}
