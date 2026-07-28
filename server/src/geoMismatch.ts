import { expectedCountryForSite, expectedRegionSet } from "./expectedCountry.js";
import { fetchCountryBreakdown, fetchCountryChannelBreakdown } from "./metrics.js";
import { getSites, saveGeoMismatches, type GeoMismatchRecord } from "./repo.js";

// Below this volume, a country's share is too noisy to draw any conclusion from.
const MIN_SESSIONS_TO_EVALUATE = 200;
// Flag when a single unexpected country accounts for at least this share of a
// site's traffic -- below this, it's not worth an analyst's time to check.
const UNEXPECTED_SHARE_THRESHOLD = 0.2;
// Trailing window used to compute the breakdown -- long enough to smooth out daily noise.
const LOOKBACK_DAYS = 30;
// Within the unexpected country's own traffic, the share above which a channel
// is considered "dominant" enough to drive the action-plan hypothesis.
const DOMINANT_CHANNEL_SHARE = 0.4;

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
 * Starter analysis / action plan in French, differentiated by whether the
 * unexpected country's traffic is mostly organic or mostly direct -- the two
 * point to different root causes and different urgency:
 *  - organic-dominant: likely an SEO/indexation issue (hreflang/ccTLD signals
 *    telling Google to rank this site for the wrong country) or an organic bot
 *    wave misattributed to that country -- worth cross-checking against the
 *    Bots tab before treating it as a real audience.
 *  - direct-dominant: more likely a real, legitimate audience (diaspora,
 *    existing customers typing the URL directly, bookmarks) -- lower urgency,
 *    worth confirming with the local sales team rather than "fixing" anything.
 */
function buildActionPlan(siteName: string, expectedLbl: string, country: string, organicShare: number, directShare: number): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (organicShare >= DOMINANT_CHANNEL_SHARE && organicShare >= directShare) {
    return (
      `Trafic majoritairement organique (${pct(organicShare)}) depuis ${country} sur ${siteName} (attendu : ${expectedLbl}). ` +
      `Piste probable : signal SEO mal ciblé (hreflang/ccTLD, sitemap indexé sur ce pays) ou vague de bots/crawlers classés à tort ` +
      `en organique -- à croiser avec l'onglet Bots avant d'agir. Actions : vérifier la couverture Search Console pour ${country}, ` +
      `contrôler les balises hreflang de ce site, et comparer avec les pics détectés dans l'onglet Bots sur la même période.`
    );
  }
  if (directShare >= DOMINANT_CHANNEL_SHARE && directShare > organicShare) {
    return (
      `Trafic majoritairement direct (${pct(directShare)}) depuis ${country} sur ${siteName} (attendu : ${expectedLbl}). ` +
      `Piste probable : audience réelle et légitime (diaspora, clients existants qui tapent l'URL, favoris) plutôt qu'un problème ` +
      `technique -- urgence faible. Action : confirmer auprès de l'équipe commerciale locale si une clientèle dans ce pays est ` +
      `attendue avant toute action corrective.`
    );
  }
  return (
    `Trafic depuis ${country} réparti entre plusieurs canaux (organique ${pct(organicShare)}, direct ${pct(directShare)}) sur ` +
    `${siteName} (attendu : ${expectedLbl}). Action : vérifier les canaux référents/campagnes ciblant ce pays avant de conclure.`
  );
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

    const channelBreakdown = await fetchCountryChannelBreakdown(site.id, dateFrom, dateTo);
    const countryChannelSessions = channelBreakdown.filter((c) => c.country === topUnexpected.country);
    const countryTotal = countryChannelSessions.reduce((a, c) => a + c.sessions, 0);
    const shareOfChannel = (channel: "organic" | "direct") =>
      countryTotal > 0 ? countryChannelSessions.filter((c) => c.channel === channel).reduce((a, c) => a + c.sessions, 0) / countryTotal : 0;
    const unexpectedOrganicShare = shareOfChannel("organic");
    const unexpectedDirectShare = shareOfChannel("direct");

    results.push({
      siteId: site.id,
      siteName: site.name,
      expectedLabel: expectedLabel(site.name),
      expectedShare,
      topUnexpectedCountry: topUnexpected.country,
      topUnexpectedShare,
      totalSessions,
      unexpectedOrganicShare,
      unexpectedDirectShare,
      actionPlan: buildActionPlan(site.name, expectedLabel(site.name), topUnexpected.country, unexpectedOrganicShare, unexpectedDirectShare),
    });
  }

  results.sort((a, b) => b.topUnexpectedShare - a.topUnexpectedShare);
  await saveGeoMismatches(results);
  return results;
}
