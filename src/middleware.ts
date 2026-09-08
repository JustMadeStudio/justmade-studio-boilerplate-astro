import { defineMiddleware } from 'astro:middleware';
import { isProdRequest } from '@/lib/host';
import { assertEnv } from '@/lib/env';

// Validate env when the SSR entry loads (i.e. at server boot), so a misconfigured
// prod deploy dies immediately instead of on the first CMS request.
assertEnv();

/**
 * Three responsibilities, applied to every response:
 *
 * 1. Security headers - sane defaults on every route.
 * 2. CSP frame-ancestors - the site can be embedded in the Justmade Studio inline
 *    editor (preview iframe on studio.justmade.be) but is clickjack-protected
 *    everywhere else.
 * 3. Indexing guard - only the canonical production host (PUBLIC_SITE_URL) may be
 *    indexed. Every other host (preview/staging deploys, raw IPs, localhost)
 *    gets `X-Robots-Tag: noindex, nofollow`. The dynamic robots.txt and sitemap
 *    enforce the same rule at the crawl level.
 */
const APP_ORIGIN = process.env.JUSTMADE_BASE_URL || 'https://studio.justmade.be';

export const onRequest = defineMiddleware(async (ctx, next) => {
  const res = await next();

  // 1. Security headers.
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  res.headers.set('x-frame-options', 'SAMEORIGIN');
  res.headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');

  // 2. CSP for the editor embed (frame-ancestors overrides X-Frame-Options for iframes).
  const appHost = new URL(APP_ORIGIN).host;
  const appApex = appHost.split('.').slice(-2).join('.');
  res.headers.set(
    'content-security-policy',
    `frame-ancestors 'self' ${APP_ORIGIN} https://*.${appApex}`,
  );

  // 3. Indexing guard: block everything that isn't the production host.
  if (!isProdRequest(ctx.request, ctx.url)) {
    res.headers.set('x-robots-tag', 'noindex, nofollow');
  }

  return res;
});
