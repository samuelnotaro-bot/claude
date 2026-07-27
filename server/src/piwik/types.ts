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
}

export interface CountryBreakdown {
  country: string; // ISO 3166-1 alpha-2
  sessions: number;
}
