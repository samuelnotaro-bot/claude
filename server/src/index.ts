import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { initSchema } from "./db.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerBasicAuth } from "./basicAuth.js";
import { registerStaticWeb } from "./staticWeb.js";
import { startScheduler } from "./scheduler.js";
import { getLatestSynthesis } from "./repo.js";
import { backfillAll } from "./backfill.js";
import { runAutomaticRecovery } from "./autoRecovery.js";

await initSchema();

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

try {
  const address = await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Piwik Trends Analyzer API listening on ${address} (mode=${config.mode})`);
  startScheduler();
  if (!(await getLatestSynthesis())) {
    // First boot on a fresh deploy (e.g. a new Render service): populate history in the
    // background instead of requiring shell access to run `npm run backfill` manually.
    // The server already accepts requests while this runs; pages just show empty data
    // until it completes. Chains straight into runAutomaticRecovery so a fresh deploy
    // goes all the way to the full 26-month retention floor on its own, not just the
    // initial quick window -- no manual "Étendre l'historique" click needed.
    app.log.warn("Aucune donnée trouvée -- lancement automatique d'un backfill en arrière-plan.");
    backfillAll()
      .then(() => runAutomaticRecovery())
      .catch((err) => app.log.error({ err }, "Backfill automatique au démarrage échoué"));
  } else {
    // Already has history: drive it automatically to "complete back to the
    // retention floor, no gaps" -- extends further back if needed, then
    // closes any holes left by cron runs missed while asleep (Render
    // free-tier spin-down) or a transient API failure. No-ops quickly if
    // already complete. Also available on demand via POST
    // /api/data/deep-backfill and /api/data/fill-gaps (see routes/api.ts),
    // and re-run periodically while awake (see scheduler.ts) so a large
    // backlog keeps closing without needing the app to restart.
    runAutomaticRecovery().catch((err) => app.log.error({ err }, "Récupération automatique au démarrage échouée"));
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
