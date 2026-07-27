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

export function demoTopCountry(siteId: string): CountryBreakdown | null {
  const def = SITE_DEFS.find((s) => s.id === siteId);
  if (!def) return null;
  return { country: def.country, sessions: def.tier * 30 };
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
  };
}
