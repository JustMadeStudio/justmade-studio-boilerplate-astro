import { env } from './env';

/**
 * Resolve the real request host.
 *
 * The Astro node standalone adapter always reports `url.host` as `localhost`
 * (it does not trust the Host header for the parsed URL). Behind a reverse
 * proxy the real host is in `x-forwarded-host`; direct hits carry it in `host`.
 * We prefer forwarded, then host, then the parsed url as a last resort.
 */
export function requestHost(request: Request, fallbackUrl?: URL): string {
  const xfh = request.headers.get('x-forwarded-host');
  if (xfh) return xfh.split(',')[0].trim().toLowerCase();
  const host = request.headers.get('host');
  if (host) return host.trim().toLowerCase();
  return (fallbackUrl?.host || '').toLowerCase();
}

/** Canonical production host from PUBLIC_SITE_URL, or null if unset/invalid. */
export function prodHost(): string | null {
  const site = env('PUBLIC_SITE_URL');
  if (!site) return null;
  try {
    return new URL(site).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Strip an optional :port so host comparison ignores port differences. */
function bare(h: string): string {
  return h.replace(/:\d+$/, '');
}

/** True when the request is served on the canonical production host. */
export function isProdRequest(request: Request, fallbackUrl?: URL): boolean {
  const canonical = prodHost();
  if (!canonical) return false;
  return bare(requestHost(request, fallbackUrl)) === bare(canonical);
}
