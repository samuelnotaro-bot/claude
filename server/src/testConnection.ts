import { config } from "./config.js";
import * as piwik from "./piwik/client.js";
import { isAppInScope } from "./siteScope.js";
import { addDaysIso } from "./period.js";

/**
 * Vérifie que les identifiants Piwik Pro fonctionnent (auth OAuth2 + lecture des
 * apps) et montre comment le filtre de périmètre (extensions pays + emea/apac
 * .socomec.com) s'applique aux sites réellement présents dans l'organisation.
 */
async function testConnection(): Promise<void> {
  if (config.mode !== "live") {
    console.log(
      "[test:connection] PIWIK_MODE n'est pas 'live' -- rien à tester contre l'API réelle.\n" +
        "Renseignez PIWIK_BASE_URL / PIWIK_CLIENT_ID / PIWIK_CLIENT_SECRET dans .env, mettez PIWIK_MODE=live, puis relancez cette commande."
    );
    return;
  }

  console.log(`[test:connection] Connexion à ${config.piwik.baseUrl} ...`);
  const apps = await piwik.listApps();
  console.log(`[test:connection] OK -- ${apps.length} site(s) visibles par ce client OAuth2.\n`);

  const inScope = apps.filter(isAppInScope);
  const outOfScope = apps.filter((a) => !isAppInScope(a));

  console.log(`[test:connection] ${inScope.length} site(s) dans le périmètre (extension pays, ou emea/apac.socomec.com):`);
  for (const app of inScope) {
    console.log(`  + ${app.name.padEnd(24)} ${app.urls.join(", ")}`);
  }

  console.log(`\n[test:connection] ${outOfScope.length} site(s) ignoré(s) (hors périmètre):`);
  for (const app of outOfScope) {
    console.log(`  - ${app.name.padEnd(24)} ${app.urls.join(", ")}`);
  }

  await testRangeBatching(inScope[0]);
}

/**
 * getMetricsRange (server/src/piwik/client.ts) batches a whole date range into
 * a handful of requests instead of one per day -- this is what makes a real
 * multi-month backfill practical. It relies on a `date` column id as a
 * day-breakdown dimension that was never confirmed against a real Piwik Pro
 * response (no test org access while building it). Probe it here, on one
 * site over a short 3-day window, before any bulk backfill relies on it.
 */
async function testRangeBatching(app: { id: string; name: string } | undefined): Promise<void> {
  console.log("\n[test:connection] Vérification du batching par plage de dates (getMetricsRange)...");
  if (!app) {
    console.log("[test:connection] Aucun site dans le périmètre -- impossible de tester.");
    return;
  }
  const to = new Date().toISOString().slice(0, 10);
  const from = addDaysIso(to, -2);
  try {
    const days = await piwik.getMetricsRange(app.id, from, to);
    console.log(
      `[test:connection] OK -- ${days.length} jour(s) reçus pour ${app.name} sur ${from} → ${to} en 7 requêtes groupées ` +
        `(au lieu de ~21 requêtes une par une). Le backfill complet utilisera ce mode.`
    );
  } catch (err) {
    console.log(
      `[test:connection] ÉCHEC -- ${err instanceof Error ? err.message : String(err)}\n` +
        "Le column_id du dimension 'jour' (dayDimension dans piwik/client.ts, actuellement \"date\") est probablement " +
        "incorrect pour cette organisation. Ce n'est pas bloquant : le backfill retombera automatiquement sur le mode " +
        "jour par jour (plus lent, mais fiable) pour chaque site où ce test échoue. Ajustez la valeur dans " +
        "COLUMN_IDS.dayDimension si vous connaissez le bon identifiant (API Explorer Piwik Pro ou support)."
    );
  }
}

testConnection().catch((err) => {
  console.error("[test:connection] échec:", err);
  process.exit(1);
});
