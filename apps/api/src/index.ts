import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const app = buildServer(config);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
