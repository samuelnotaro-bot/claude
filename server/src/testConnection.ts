import { config } from "./config.js";
import * as piwik from "./piwik/client.js";
import { isAppInScope } from "./siteScope.js";

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
}

testConnection().catch((err) => {
  console.error("[test:connection] échec:", err);
  process.exit(1);
});
