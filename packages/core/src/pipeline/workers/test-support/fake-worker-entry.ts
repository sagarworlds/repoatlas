// A fake extraction worker for pool tests. Behaviour is chosen by the content of the file:
//   CRASH        the worker thread exits (like an OOM kill)
//   THROW        an uncaught exception in the worker
//   HANG         never answers (watchdog test)
//   FAIL         answers with a failure message
//   BAD          answers with output that is not a valid extraction
//   SLOW:<ms>    answers after a delay
// anything else answers with a valid empty extraction.
import { parentPort } from "node:worker_threads";
import type { ToWorkerMessage } from "../messages.ts";

const port = parentPort;
if (port === null) throw new Error("must run in a worker");

let chain: Promise<void> = Promise.resolve();
port.on("message", (message: ToWorkerMessage) => {
  chain = chain.then(async () => {
    if (message.type !== "extract") return;
    const { content, jobId, path } = message;
    if (content.startsWith("CRASH")) process.exit(3);
    if (content.startsWith("THROW")) throw new Error("boom");
    if (content.startsWith("HANG")) await new Promise(() => undefined);
    if (content.startsWith("FAIL")) {
      port.postMessage({ type: "failure", jobId, message: "plugin said no" });
      return;
    }
    if (content.startsWith("BAD")) {
      port.postMessage({ type: "result", jobId, extraction: { nonsense: true } });
      return;
    }
    if (content.startsWith("SLOW:")) {
      await new Promise((r) => setTimeout(r, Number(content.slice(5))));
    }
    port.postMessage({
      type: "result",
      jobId,
      extraction: {
        file: path,
        language: "python",
        definitions: [],
        imports: [],
        references: [],
        parseErrors: 0,
      },
    });
  });
});
port.postMessage({ type: "ready" });
