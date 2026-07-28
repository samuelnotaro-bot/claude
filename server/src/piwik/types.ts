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
  /**
   * These 5 fields depend on Piwik Pro queries that can fail independently of
   * the core metrics above (unsupported column for this org, an integration
   * like Search Console not configured for this specific site, a transient
   * API error, ...). `null` means "couldn't be fetched", not "confirmed
   * zero" -- see the matching doc comment on trends.DayPoint for how that
   * distinction is preserved through aggregation and surfaced in the UI as
   * "non disponible" instead of a misleading 0.
   */
  /** Sessions whose `source` matches a known AI assistant domain (see aiReferrers.ts). */
  aiReferralSessions: number | null;
  /** Single-pageview ("bounced") sessions on the organic channel -- a bot-trend proxy signal. */
  organicBounces: number | null;
  /** Single-pageview ("bounced") sessions on the direct channel -- a bot-trend proxy signal. */
  directBounces: number | null;
  /** Google Search Console clicks for this site/day, via Piwik Pro's GSC integration. */
  searchConsoleClicks: number | null;
  /** Google Search Console impressions for this site/day, via Piwik Pro's GSC integration. */
  searchConsoleImpressions: number | null;
}

export interface CountryBreakdown {
  country: string; // ISO 3166-1 alpha-2
  sessions: number;
}
