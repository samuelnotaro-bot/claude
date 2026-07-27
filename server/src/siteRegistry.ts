import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { countryToContinent } from "./continent.js";
import { upsertSite, pruneSites, getSites, type SiteRecord } from "./repo.js";
import * as piwik from "./piwik/client.js";
import { demoApps, demoTopCountry } from "./demoData.js";
import { isAppInScope } from "./siteScope.js";

const OVERRIDES_PATH = path.resolve(process.cwd(), "../config/site-overrides.json");

function loadOverrides(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Discovers all sites from Piwik Pro (or demo data) and auto-assigns each one to a
 * continent based on its dominant traffic-source country over the trailing window.
 * A manual override in config/site-overrides.json (siteId -> continent) always wins.
 */
export async function syncSiteRegistry(lookbackDays = 90): Promise<SiteRecord[]> {
  const overrides = loadOverrides();
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - lookbackDays);
  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = to.toISOString().slice(0, 10);

  const allApps = config.mode === "live" ? await piwik.listApps() : demoApps();
  const apps = allApps.filter(isAppInScope);
  const excluded = allApps.length - apps.length;
  if (excluded > 0) {
    console.log(
      `[siteRegistry] ${excluded} site(s) hors périmètre ignoré(s) (pas d'extension pays, ou sous-domaine socomec.com non autorisé).`
    );
  }

  for (const app of apps) {
    const override = overrides[app.id];
    if (override) {
      upsertSite({
        id: app.id,
        name: app.name,
        continent: override as any,
        continentSource: "manual",
        detectedCountry: null,
      });
      continue;
    }

    const top =
      config.mode === "live"
        ? await piwik.getTopCountry(app.id, dateFrom, dateTo)
        : demoTopCountry(app.id);

    upsertSite({
      id: app.id,
      name: app.name,
      continent: countryToContinent(top?.country),
      continentSource: "auto",
      detectedCountry: top?.country ?? null,
    });
  }

  pruneSites(apps.map((app) => app.id));

  return getSites();
}
