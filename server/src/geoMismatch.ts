import { expectedCountryForSite, expectedRegionSet } from "./expectedCountry.js";
import { fetchCountryBreakdown } from "./metrics.js";
import { getSites, saveGeoMismatches, type GeoMismatchRecord } from "./repo.js";

// Below this volume, a country's share is too noisy to draw any conclusion from.
const MIN_SESSIONS_TO_EVALUATE = 200;
// Flag when a single unexpected country accounts for at least this share of a site's traffic.
const UNEXPECTED_SHARE_THRESHOLD = 0.15;
// Trailing window used to compute the breakdown -- long enough to smooth out daily noise.
const LOOKBACK_DAYS = 30;

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function expectedLabel(siteName: string): string {
  if (siteName === "apac.socomec.com") return "Asie (hors Chine et Inde)";
  if (siteName === "emea.socomec.com") return "Europe / Afrique / Moyen-Orient (hors pays avec site dédié)";
  return expectedCountryForSite(siteName) ?? "";
}

/**
 * Flags sites where a large, single unexpected country makes up a substantial
 * share of traffic (e.g. India traffic landing on the UK site) -- a signal
 * worth checking (geo-targeting/redirect misconfiguration, or a legitimate
 * multinational audience). The two regional sites (emea./apac.socomec.com) use
 * a broader region-level rule instead of a single expected country (see
 * expectedRegionSet in expectedCountry.ts).
 */
export async function checkGeoMismatches(): Promise<GeoMismatchRecord[]> {
  const sites = await getSites();
  const dateFrom = dateNDaysAgo(LOOKBACK_DAYS);
  const dateTo = dateNDaysAgo(0);

  // Countries that already have their own dedicated site -- traffic from these
  // landing on emea.socomec.com instead is itself worth flagging.
  const dedicatedCountries = new Set(
    sites.map((s) => expectedCountryForSite(s.name)).filter((c): c is string => c !== null)
  );

  const results: GeoMismatchRecord[] = [];
  for (const site of sites) {
    const expectedSet = expectedRegionSet(site.name, dedicatedCountries) ?? (() => {
      const single = expectedCountryForSite(site.name);
      return single ? new Set([single]) : null;
    })();
    if (!expectedSet) continue;

    const breakdown = await fetchCountryBreakdown(site.id, dateFrom, dateTo);
    const totalSessions = breakdown.reduce((a, c) => a + c.sessions, 0);
    if (totalSessions < MIN_SESSIONS_TO_EVALUATE) continue;

    const expectedSessions = breakdown.filter((c) => expectedSet.has(c.country)).reduce((a, c) => a + c.sessions, 0);
    const expectedShare = expectedSessions / totalSessions;

    const topUnexpected = breakdown.filter((c) => !expectedSet.has(c.country)).sort((a, b) => b.sessions - a.sessions)[0];
    if (!topUnexpected) continue;
    const topUnexpectedShare = topUnexpected.sessions / totalSessions;
    if (topUnexpectedShare < UNEXPECTED_SHARE_THRESHOLD) continue;

    results.push({
      siteId: site.id,
      siteName: site.name,
      expectedLabel: expectedLabel(site.name),
      expectedShare,
      topUnexpectedCountry: topUnexpected.country,
      topUnexpectedShare,
      totalSessions,
    });
  }

  results.sort((a, b) => b.topUnexpectedShare - a.topUnexpectedShare);
  await saveGeoMismatches(results);
  return results;
}
