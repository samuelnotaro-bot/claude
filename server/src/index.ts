import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registerApiRoutes } from "./routes/api.js";
import { startScheduler } from "./scheduler.js";
import { getLatestSynthesis } from "./repo.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await registerApiRoutes(app);

app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Piwik Trends Analyzer API listening on ${address} (mode=${config.mode})`);
  startScheduler();
  if (!getLatestSynthesis()) {
    app.log.warn("No synthesis found yet -- run `npm run backfill` (or `npm run seed:demo`) to populate history.");
  }
});
