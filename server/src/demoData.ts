import type { PiwikApp, DailySiteMetrics, CountryBreakdown, Channel } from "./piwik/types.js";

/**
 * Deterministic mock data used when PIWIK_MODE=demo, so the whole app (backfill,
 * scheduler, trend engine, dashboard) can be exercised without real Piwik Pro
 * credentials. Sites spread across the 3 business regions (NAM/APAC/EMEA), with a few sites carrying
 * deliberate trend/anomaly patterns (traffic drop, conversion divergence, channel
 * mix shift) so the trend engine and synthesis have something real to surface.
 */

interface DemoSiteDef {
  id: string;
  name: string;
  country: string;
  tier: number; // base daily sessions order of magnitude
  trend: "flat" | "growing" | "declining" | "recent_drop" | "conversion_decline" | "channel_shift";
}

const SITE_DEFS: DemoSiteDef[] = [
  { id: "site-fr", name: "socomec.fr", country: "FR", tier: 4000, trend: "recent_drop" },
  { id: "site-de", name: "socomec.de", country: "DE", tier: 3600, trend: "growing" },
  { id: "site-gb", name: "socomec.co.uk", country: "GB", tier: 3200, trend: "flat" },
  { id: "site-es", name: "socomec.es", country: "ES", tier: 2200, trend: "conversion_decline" },
  { id: "site-it", name: "socomec.it", country: "IT", tier: 2000, trend: "flat" },
  { id: "site-nl", name: "socomec.nl", country: "NL", tier: 1400, trend: "flat" },
  { id: "site-pl", name: "socomec.pl", country: "PL", tier: 1100, trend: "growing" },
  { id: "site-se", name: "socomec.se", country: "SE", tier: 900, trend: "flat" },

  { id: "site-us", name: "socomec.us", country: "US", tier: 6000, trend: "channel_shift" },
  { id: "site-ca", name: "socomec.ca", country: "CA", tier: 1500, trend: "growing" },
  { id: "site-mx", name: "socomec.mx", country: "MX", tier: 1200, trend: "flat" },

  { id: "site-jp", name: "socomec.jp", country: "JP", tier: 2400, trend: "declining" },
  { id: "site-cn", name: "socomec.cn", country: "CN", tier: 3000, trend: "flat" },
  { id: "site-in", name: "socomec.co.in", country: "IN", tier: 2800, trend: "growing" },
  { id: "site-kr", name: "socomec.kr", country: "KR", tier: 1300, trend: "flat" },
  { id: "site-sg", name: "socomec.sg", country: "SG", tier: 900, trend: "flat" },

  { id: "site-br", name: "socomec.com.br", country: "BR", tier: 1800, trend: "flat" },
  { id: "site-ar", name: "socomec.com.ar", country: "AR", tier: 700, trend: "declining" },

  { id: "site-za", name: "socomec.co.za", country: "ZA", tier: 600, trend: "flat" },
  { id: "site-ma", name: "socomec.ma", country: "MA", tier: 500, trend: "flat" },

  { id: "site-au", name: "socomec.com.au", country: "AU", tier: 1600, trend: "flat" },

  // Sous-domaines régionaux de socomec.com explicitement autorisés (pas d'extension pays).
  { id: "site-emea", name: "emea.socomec.com", country: "FR", tier: 2500, trend: "flat" },
  { id: "site-apac", name: "apac.socomec.com", country: "SG", tier: 1800, trend: "flat" },

  // Hors périmètre : sous-domaine socomec.com non autorisé, filtré par isAppInScope.
  { id: "site-shop", name: "shop.socomec.com", country: "US", tier: 2600, trend: "flat" },
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoApps(): PiwikApp[] {
  return SITE_DEFS.map((s) => ({
    id: s.id,
    name: s.name,
    urls: [`https://${s.name}`],
    timezone: "UTC",
    currency: "EUR",
  }));
}

const ALL_DEMO_COUNTRIES = [...new Set(SITE_DEFS.map((s) => s.country)), "IN"];

/**
 * Full visitor-country breakdown for a demo site over its recent traffic, mostly
 * dominated by its home country. socomec.co.uk deliberately carries a large,
 * unexpected India share so the geo-mismatch detector (geoMismatch.ts) has a
 * real case to catch -- mirroring the exact scenario reported for the real site.
 */
export function demoCountryBreakdown(siteId: string): CountryBreakdown[] {
  const def = SITE_DEFS.find((s) => s.id === siteId);
  if (!def) return [];
  const rng = mulberry32(hashStr(siteId + "geo"));
  const totalSessions = def.tier * 30;

  // Regional multi-country sites: give them a distribution that already fits
  // their expected-region rule (see geoMismatch.ts) -- Asia excluding CN/IN for
  // apac, EMEA countries without their own dedicated site for emea -- so
  // socomec.co.uk stays the single deliberate example below.
  if (siteId === "site-emea") return distributeAcross(totalSessions, ["BE", "CH", "AT", "PT", "AE", "SA", "GR"], rng);
  if (siteId === "site-apac") return distributeAcross(totalSessions, ["TH", "VN", "MY", "ID", "PH", "TW"], rng);

  const isMismatchDemo = siteId === "site-gb";
  const homeShare = isMismatchDemo ? 0.42 : 0.7 + rng() * 0.15;
  const mismatchShare = isMismatchDemo ? 0.31 : 0;

  const rows: CountryBreakdown[] = [{ country: def.country, sessions: Math.round(totalSessions * homeShare) }];
  if (mismatchShare > 0) rows.push({ country: "IN", sessions: Math.round(totalSessions * mismatchShare) });

  let remaining = Math.max(0, 1 - homeShare - mismatchShare);
  const others = ALL_DEMO_COUNTRIES.filter((c) => c !== def.country && c !== (isMismatchDemo ? "IN" : ""));
  for (const c of others) {
    if (remaining <= 0.01) break;
    const share = remaining * rng() * 0.35;
    rows.push({ country: c, sessions: Math.round(totalSessions * share) });
    remaining -= share;
  }
  return rows.filter((r) => r.sessions > 0).sort((a, b) => b.sessions - a.sessions);
}

function distributeAcross(totalSessions: number, countries: string[], rng: () => number): CountryBreakdown[] {
  const weights = countries.map(() => 0.4 + rng() * 0.6);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  return countries
    .map((country, i) => ({ country, sessions: Math.round((totalSessions * weights[i]) / totalWeight) }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Country x channel breakdown for the geo-mismatch "direct vs organic" split
 * (see geoMismatch.ts). Mirrors demoCountryBreakdown's country totals, split
 * across channels -- the deliberate India-on-UK mismatch skews heavily organic
 * to exercise the "likely SEO/bot" action-plan branch.
 */
export function demoCountryChannelBreakdown(siteId: string): { country: string; channel: Channel; sessions: number }[] {
  const countries = demoCountryBreakdown(siteId);
  const rng = mulberry32(hashStr(siteId + "geo-channel"));
  const rows: { country: string; channel: Channel; sessions: number }[] = [];
  for (const c of countries) {
    const isMismatchCountry = siteId === "site-gb" && c.country === "IN";
    const weights: Record<Channel, number> = isMismatchCountry
      ? { organic: 0.62, direct: 0.08, referral: 0.14, paid: 0.06, social: 0.07, email: 0.02, other: 0.01 }
      : CHANNEL_WEIGHTS;
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    for (const [channel, weight] of Object.entries(weights) as [Channel, number][]) {
      const sessions = Math.round(c.sessions * (weight / totalWeight) * (0.9 + rng() * 0.2));
      if (sessions > 0) rows.push({ country: c.country, channel, sessions });
    }
  }
  return rows;
}

const CHANNEL_WEIGHTS: Record<Channel, number> = {
  organic: 0.4,
  direct: 0.22,
  referral: 0.1,
  paid: 0.15,
  social: 0.08,
  email: 0.04,
  other: 0.01,
};

export function generateDemoMetrics(siteId: string, date: string, today: Date): DailySiteMetrics {
  const def = SITE_DEFS.find((s) => s.id === siteId);
  if (!def) throw new Error(`Unknown demo site: ${siteId}`);

  const d = new Date(date + "T00:00:00Z");
  const daysAgo = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  const rng = mulberry32(hashStr(siteId + date));

  const weekday = d.getUTCDay();
  const weekendFactor = weekday === 0 || weekday === 6 ? 0.72 : 1.0;
  const noise = 0.9 + rng() * 0.2;

  let trendFactor = 1;
  let convRateBase = 0.018 + (hashStr(siteId) % 100) / 5000; // ~1.8% - 3.8%
  const channelWeights: Record<Channel, number> = { ...CHANNEL_WEIGHTS };

  switch (def.trend) {
    case "growing":
      trendFactor = 1 + (90 - daysAgo) * 0.004; // steady growth as we approach today
      break;
    case "declining":
      trendFactor = 1 - (90 - daysAgo) * 0.003;
      break;
    case "recent_drop":
      trendFactor = daysAgo <= 7 ? 0.58 : 1; // sharp drop confined to the most recent week
      break;
    case "conversion_decline":
      if (daysAgo <= 7) convRateBase *= 0.45; // traffic steady, conversion collapses this week
      break;
    case "channel_shift":
      if (daysAgo <= 7) {
        channelWeights.organic -= 0.18; // sudden channel mix shift this week
        channelWeights.paid += 0.18;
      }
      break;
  }

  const sessions = Math.max(0, Math.round(def.tier * weekendFactor * trendFactor * noise));
  const users = Math.round(sessions * (0.78 + rng() * 0.1));
  const pageviews = Math.round(sessions * (2.1 + rng() * 1.4));
  const goalConversions = Math.round(sessions * Math.max(0.001, convRateBase) * (0.9 + rng() * 0.2));
  const bounceRate = Math.min(0.85, Math.max(0.2, 0.45 + (rng() - 0.5) * 0.1));
  const avgSessionDurationSec = 90 + rng() * 120;
  // Rough split matching the real Piwik Pro goal mix: quote requests and support
  // requests are two of several goal types making up total goalConversions.
  const rfqConversions = Math.round(goalConversions * (0.35 + rng() * 0.1));
  const supportConversions = Math.round(goalConversions * (0.12 + rng() * 0.06));
  const downloads = Math.round(sessions * (0.12 + rng() * 0.08));

  const totalWeight = Object.values(channelWeights).reduce((a, b) => a + b, 0);
  const channels = Object.fromEntries(
    (Object.entries(channelWeights) as [Channel, number][]).map(([ch, w]) => [
      ch,
      Math.round(sessions * (w / totalWeight)),
    ])
  ) as Record<Channel, number>;

  // A small, steady share of AI-assistant referrals, growing slightly closer to
  // today so the trend engine has a realistic "traffic from AI grows" signal.
  const aiReferralShare = 0.01 + Math.max(0, (60 - daysAgo) / 60) * 0.03;
  const aiReferralSessions = Math.round(sessions * aiReferralShare * (0.8 + rng() * 0.4));

  // Bounce sessions on organic/direct -- the "site-us" demo site carries a
  // deliberate bot-trend pattern (rising low-engagement share in recent days)
  // so the Bots tab has something concrete to surface.
  const botTrendSite = def.id === "site-us";
  const baseBounceShare = 0.22 + rng() * 0.08;
  const bounceShare = botTrendSite && daysAgo <= 14 ? baseBounceShare + (14 - daysAgo) * 0.02 : baseBounceShare;
  const organicBounces = Math.round(channels.organic * Math.min(0.9, bounceShare));
  const directBounces = Math.round(channels.direct * Math.min(0.9, bounceShare * 0.8));

  // Search Console: only a subset of demo sites simulate having the GSC
  // integration configured, matching the real-world "not every site has it
  // set up in Piwik Pro" situation this app has to tolerate -- null (not 0),
  // since "not configured" is an unavailable data point, not a confirmed zero.
  const hasSearchConsoleDemo = hashStr(def.id) % 3 !== 0;
  const searchConsoleImpressions = hasSearchConsoleDemo ? Math.round(channels.organic * (18 + rng() * 12)) : null;
  const searchConsoleClicks = hasSearchConsoleDemo && searchConsoleImpressions !== null ? Math.round(searchConsoleImpressions * (0.02 + rng() * 0.03)) : null;

  return {
    siteId,
    date,
    sessions,
    users,
    pageviews,
    goalConversions,
    bounceRate,
    avgSessionDurationSec,
    channels,
    rfqConversions,
    supportConversions,
    downloads,
    aiReferralSessions,
    organicBounces,
    directBounces,
    searchConsoleClicks,
    searchConsoleImpressions,
  };
}
