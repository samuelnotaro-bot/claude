import type { PiwikApp, DailySiteMetrics, CountryBreakdown, Channel } from "./piwik/types.js";

/**
 * Deterministic mock data used when PIWIK_MODE=demo, so the whole app (backfill,
 * scheduler, trend engine, dashboard) can be exercised without real Piwik Pro
 * credentials. 22 sites spread across 6 continents, with a few sites carrying
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
  { id: "site-fr", name: "site-fr.com", country: "FR", tier: 4000, trend: "recent_drop" },
  { id: "site-de", name: "site-de.com", country: "DE", tier: 3600, trend: "growing" },
  { id: "site-gb", name: "site-gb.com", country: "GB", tier: 3200, trend: "flat" },
  { id: "site-es", name: "site-es.com", country: "ES", tier: 2200, trend: "conversion_decline" },
  { id: "site-it", name: "site-it.com", country: "IT", tier: 2000, trend: "flat" },
  { id: "site-nl", name: "site-nl.com", country: "NL", tier: 1400, trend: "flat" },
  { id: "site-pl", name: "site-pl.com", country: "PL", tier: 1100, trend: "growing" },
  { id: "site-se", name: "site-se.com", country: "SE", tier: 900, trend: "flat" },

  { id: "site-us", name: "site-us.com", country: "US", tier: 6000, trend: "channel_shift" },
  { id: "site-us-shop", name: "site-us-shop.com", country: "US", tier: 2600, trend: "flat" },
  { id: "site-ca", name: "site-ca.com", country: "CA", tier: 1500, trend: "growing" },
  { id: "site-mx", name: "site-mx.com", country: "MX", tier: 1200, trend: "flat" },

  { id: "site-jp", name: "site-jp.com", country: "JP", tier: 2400, trend: "declining" },
  { id: "site-cn", name: "site-cn.com", country: "CN", tier: 3000, trend: "flat" },
  { id: "site-in", name: "site-in.com", country: "IN", tier: 2800, trend: "growing" },
  { id: "site-kr", name: "site-kr.com", country: "KR", tier: 1300, trend: "flat" },
  { id: "site-sg", name: "site-sg.com", country: "SG", tier: 900, trend: "flat" },

  { id: "site-br", name: "site-br.com", country: "BR", tier: 1800, trend: "flat" },
  { id: "site-ar", name: "site-ar.com", country: "AR", tier: 700, trend: "declining" },

  { id: "site-za", name: "site-za.com", country: "ZA", tier: 600, trend: "flat" },
  { id: "site-ma", name: "site-ma.com", country: "MA", tier: 500, trend: "flat" },

  { id: "site-au", name: "site-au.com", country: "AU", tier: 1600, trend: "flat" },
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
  };
}
