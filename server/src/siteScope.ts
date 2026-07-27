/**
 * Determines which Piwik Pro apps are in scope for this dashboard.
 *
 * Business rule: only track official Socomec country sites -- a bare (or
 * "www."-prefixed) socomec.<ccTLD> domain, e.g. socomec.fr, socomec.co.uk,
 * socomec.com.br -- plus two named regional exceptions on the generic
 * socomec.com domain: emea.socomec.com and apac.socomec.com. Everything else
 * is out of scope: other socomec.com subdomains (apex, tool/portal
 * subdomains like selector., eorder., go., jade., static., *.my.site.com,
 * ...), subdomains of a ccTLD socomec domain (e.g. eorder.socomec.us), and
 * unrelated third-party domains that merely happen to end in a ccTLD (e.g.
 * revoltra.us, megacon.se -- other clients tracked in the same Piwik Pro
 * organization). Apps whose name contains "selector" are excluded outright,
 * regardless of domain: these internal product-configurator tools sometimes
 * declare a real country domain (e.g. www.socomec.fr) as their app URL, which
 * would otherwise pass the domain check above.
 */

const ALLOWED_DOTCOM_HOSTS = new Set(["emea.socomec.com", "apac.socomec.com"]);

// Matches "socomec.<ccTLD>" or "socomec.<generic>.<ccTLD>" (e.g. socomec.co.uk,
// socomec.com.br), with an optional leading "www.".
const SOCOMEC_CCTLD_HOST = /^(?:www\.)?socomec\.(?:[a-z]{2,3}\.)?[a-z]{2}$/i;

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isHostInScope(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "socomec.com" || host.endsWith(".socomec.com")) {
    return ALLOWED_DOTCOM_HOSTS.has(host);
  }
  return SOCOMEC_CCTLD_HOST.test(host);
}

// Explicit exclusion: internal product-selector tools (e.g. "Switches selector -
// TEST") sometimes reuse a real country domain as their declared URL, which would
// otherwise slip past the domain-only check above.
const EXCLUDED_NAME_PATTERN = /selector/i;

export function isAppInScope(app: { name: string; urls: string[] }): boolean {
  if (EXCLUDED_NAME_PATTERN.test(app.name)) return false;
  return app.urls.some((url) => {
    const host = hostnameOf(url);
    return host !== null && isHostInScope(host);
  });
}
