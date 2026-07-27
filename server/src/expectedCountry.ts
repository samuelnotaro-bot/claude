// Only Socomec's UK site has a ccTLD that differs from its ISO 3166-1 alpha-2
// country code (.uk vs GB); every other in-scope ccTLD already equals its ISO code.
const TLD_TO_ISO: Record<string, string> = { uk: "GB" };

// Regional multi-country sites: a large share of "unexpected" country traffic
// there is normal (that's the whole point of the site) -- they use a broader,
// region-level rule instead (see geoMismatch.ts), so expectedCountryForSite
// returns null for them.
const MULTI_COUNTRY_SITES = new Set(["emea.socomec.com", "apac.socomec.com"]);

/**
 * The single country a site's domain targets, derived from its ccTLD
 * (e.g. socomec.co.uk -> GB, socomec.fr -> FR). Returns null when a site has
 * no single expected country (regional multi-country sites).
 */
export function expectedCountryForSite(siteName: string): string | null {
  if (MULTI_COUNTRY_SITES.has(siteName)) return null;
  const match = siteName.match(/\.([a-z]{2,3})$/i);
  if (!match) return null;
  const tld = match[1].toLowerCase();
  return (TLD_TO_ISO[tld] ?? tld).toUpperCase();
}

// Heuristic regional groupings (ISO 3166-1 alpha-2) used only for the two
// regional multi-country sites' geo-mismatch rule below -- a practical signal
// for the dashboard, not an authoritative geopolitical classification.
export const ASIA_PACIFIC_COUNTRIES = new Set([
  "CN", "IN", "JP", "KR", "SG", "TH", "VN", "MY", "ID", "PH", "TW", "HK", "PK", "BD", "LK", "MM", "KH", "LA", "MN", "NP", "BN", "MO",
]);

export const EMEA_COUNTRIES = new Set([
  // Europe
  "FR", "DE", "GB", "IT", "ES", "NL", "BE", "PT", "CH", "AT", "SE", "NO", "DK", "FI", "IE", "PL", "CZ", "SK", "HU", "RO", "BG", "GR",
  "HR", "SI", "EE", "LV", "LT", "LU", "MT", "CY", "IS", "RS", "BA", "AL", "MK", "ME", "UA", "BY", "MD",
  // Afrique
  "ZA", "MA", "EG", "NG", "KE", "GH", "TN", "DZ", "ET", "CI", "SN", "CM", "UG", "TZ", "ZM", "ZW", "AO", "MZ", "NA", "BW", "RW", "GA",
  // Moyen-Orient
  "AE", "SA", "IL", "TR", "QA", "KW", "BH", "OM", "JO", "LB", "IQ", "IR",
]);

/**
 * Expected visitor-country set for the two regional multi-country sites:
 * - apac.socomec.com: Asia, excluding China and India (each already has its own
 *   dedicated site -- socomec.cn / socomec.co.in).
 * - emea.socomec.com: Europe/Africa/Middle East, excluding any country that
 *   already has its own dedicated site (that traffic belongs there instead).
 * Returns null for any other site (single-country rule applies instead).
 */
export function expectedRegionSet(siteName: string, dedicatedCountries: ReadonlySet<string>): Set<string> | null {
  if (siteName === "apac.socomec.com") {
    return new Set([...ASIA_PACIFIC_COUNTRIES].filter((c) => c !== "CN" && c !== "IN"));
  }
  if (siteName === "emea.socomec.com") {
    return new Set([...EMEA_COUNTRIES].filter((c) => !dedicatedCountries.has(c)));
  }
  return null;
}
