import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { businessRegionForSite, type Continent } from "./continent.js";
import { upsertSite, pruneSites, getSites, type SiteRecord } from "./repo.js";
import * as piwik from "./piwik/client.js";
import { demoApps } from "./demoData.js";
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
 * Discovers all sites from Piwik Pro (or demo data) and assigns each one to a
 * Socomec business region (NAM / APAC / EMEA) based on its domain name. A manual
 * override in config/site-overrides.json (siteId -> region) always wins, for the
 * rare exception that doesn't fit the default rule.
 */
export async function syncSiteRegistry(): Promise<SiteRecord[]> {
  const overrides = loadOverrides();

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
        continent: override as Continent,
        continentSource: "manual",
        detectedCountry: null,
      });
      continue;
    }

    upsertSite({
      id: app.id,
      name: app.name,
      continent: businessRegionForSite(app.name),
      continentSource: "auto",
      detectedCountry: null,
    });
  }

  pruneSites(apps.map((app) => app.id));

  return getSites();
}
