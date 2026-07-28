export interface PiwikApp {
  id: string;
  name: string;
  urls: string[];
  timezone: string;
  currency: string;
}

export type Channel = "organic" | "direct" | "referral" | "paid" | "social" | "email" | "other";

export interface DailySiteMetrics {
  siteId: string;
  date: string; // YYYY-MM-DD
  sessions: number;
  users: number;
  pageviews: number;
  goalConversions: number;
  bounceRate: number;
  avgSessionDurationSec: number;
  channels: Record<Channel, number>;
  /** Conversions on goals classified as a quote/RFQ request (see goalCategories.ts). */
  rfqConversions: number;
  /** Conversions on goals classified as a technical support request (see goalCategories.ts). */
  supportConversions: number;
  /** File downloads (Resource Center, datasheets, ...), a dedicated Piwik Pro metric. */
  downloads: number;
  /** Sessions whose `source` matches a known AI assistant domain (see aiReferrers.ts). */
  aiReferralSessions: number;
  /** Single-pageview ("bounced") sessions on the organic channel -- a bot-trend proxy signal. */
  organicBounces: number;
  /** Single-pageview ("bounced") sessions on the direct channel -- a bot-trend proxy signal. */
  directBounces: number;
  /** Google Search Console clicks for this site/day, via Piwik Pro's GSC integration (0 if not configured for this site). */
  searchConsoleClicks: number;
  /** Google Search Console impressions for this site/day, via Piwik Pro's GSC integration (0 if not configured for this site). */
  searchConsoleImpressions: number;
}

export interface CountryBreakdown {
  country: string; // ISO 3166-1 alpha-2
  sessions: number;
}
