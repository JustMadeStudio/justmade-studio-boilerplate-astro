import type { APIRoute } from 'astro';
import { env } from '@/lib/env';
import { isProdRequest } from '@/lib/host';

/**
 * Dynamic robots.txt. Only the canonical production host (PUBLIC_SITE_URL) gets
 * a crawlable policy; every other host (preview/staging deploys, raw IPs,
 * localhost) is fully disallowed so it never ends up in search.
 */
export const prerender = false;

const SITE_URL = env('PUBLIC_SITE_URL');

export const GET: APIRoute = ({ url, request }) => {
  const isProd = isProdRequest(request, url);

  const body = isProd
    ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL.replace(/\/$/, '')}/sitemap.xml\n`
    : `User-agent: *\nDisallow: /\n`;

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
