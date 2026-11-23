import type { LanguagePlugin, PluginProjectInfo } from "@repoatlas/plugin-api";
import type { FromWorkerMessage, ToWorkerMessage } from "./messages.ts";

/** What the worker thread does with a message. Pure logic, so it is testable without threads. */
export interface WorkerHandler {
  /** Returns the reply to send back, or undefined when the message needs none. */
  handle(message: ToWorkerMessage): Promise<FromWorkerMessage | undefined>;
}

interface Session {
  plugin: LanguagePlugin;
  info: PluginProjectInfo;
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/**
 * `lookup` finds a plugin by id (the worker entry passes the default registry).
 * Plugin errors never escape: they become a "failure" reply for that one file.
 */
export function createWorkerHandler(
  lookup: (pluginId: string) => LanguagePlugin | undefined,
): WorkerHandler {
  const sessions = new Map<number, Session>();
  return {
    async handle(message) {
      if (message.type === "session") {
        const plugin = lookup(message.pluginId);
        if (plugin) sessions.set(message.sessionId, { plugin, info: message.info });
        return undefined;
      }
      if (message.type === "end-session") {
        sessions.delete(message.sessionId);
        return undefined;
      }
      const session = sessions.get(message.sessionId);
      if (!session) {
        return { type: "failure", jobId: message.jobId, message: "unknown session or plugin" };
      }
      try {
        const extraction = await session.plugin.extract(
          {
            path: message.path,
            bytes: message.bytes,
            content: message.content,
            language: message.language,
          },
          session.info,
        );
        return { type: "result", jobId: message.jobId, extraction };
      } catch (err) {
        return { type: "failure", jobId: message.jobId, message: messageOf(err) };
      }
    },
  };
}
