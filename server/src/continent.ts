export type Continent = "NAM" | "APAC" | "EMEA";

// Fixed by Socomec's own business definition (which sites report into which
// region), not geography or auto-detected traffic origin.
const NAM_SITES = new Set(["socomec.us"]);
const APAC_SITES = new Set(["socomec.cn", "socomec.co.in", "apac.socomec.com"]);

/**
 * Socomec's own business regions (NAM / APAC / EMEA) -- not geographic
 * continents. EMEA is the catch-all: every site that isn't explicitly NAM or
 * APAC belongs to it.
 */
export function businessRegionForSite(siteName: string): Continent {
  if (NAM_SITES.has(siteName)) return "NAM";
  if (APAC_SITES.has(siteName)) return "APAC";
  return "EMEA";
}
