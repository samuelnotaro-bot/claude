/**
 * Determines which Piwik Pro apps are in scope for this dashboard.
 *
 * Business rule: only track sites on a country-code domain extension
 * (e.g. socomec.fr, socomec.co.uk, socomec.com.br -- any ccTLD as the final
 * domain label), plus two named regional exceptions on the generic
 * socomec.com domain: emea.socomec.com and apac.socomec.com. Every other
 * socomec.com host (apex, www, shop, blog, ...) and every other non-ccTLD
 * domain is out of scope.
 */

const ALLOWED_DOTCOM_HOSTS = new Set(["emea.socomec.com", "apac.socomec.com"]);

const CCTLD_PATTERN = /\.[a-z]{2}$/i;

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
  return CCTLD_PATTERN.test(host);
}

export function isAppInScope(app: { urls: string[] }): boolean {
  return app.urls.some((url) => {
    const host = hostnameOf(url);
    return host !== null && isHostInScope(host);
  });
}
