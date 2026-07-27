import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerBasicAuth } from "./basicAuth.js";
import { registerStaticWeb } from "./staticWeb.js";
import { startScheduler } from "./scheduler.js";
import { getLatestSynthesis } from "./repo.js";
import { backfillAll } from "./backfill.js";

const app = Fastify({ logger: true });

if (config.dashboard.username && config.dashboard.password) {
  registerBasicAuth(app, config.dashboard.username, config.dashboard.password);
  app.log.info(`Dashboard protégé par authentification (utilisateur: ${config.dashboard.username}).`);
} else {
  app.log.warn("Dashboard démarré sans authentification (DASHBOARD_USERNAME/DASHBOARD_PASSWORD non renseignés).");
}

await app.register(cors, { origin: true });
await registerApiRoutes(app);

// Serves the built web dashboard (web/dist) from this same server, so a single
// Render web service hosts both the API and the UI behind the same auth gate.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  registerStaticWeb(app, webDist);
}

app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Piwik Trends Analyzer API listening on ${address} (mode=${config.mode})`);
  startScheduler();
  if (!getLatestSynthesis()) {
    // First boot on a fresh deploy (e.g. a new Render service): populate history in the
    // background instead of requiring shell access to run `npm run backfill` manually.
    // The server already accepts requests while this runs; pages just show empty data
    // until it completes.
    app.log.warn("Aucune donnée trouvée -- lancement automatique d'un backfill en arrière-plan.");
    backfillAll().catch((err) => app.log.error({ err }, "Backfill automatique au démarrage échoué"));
  }
});
