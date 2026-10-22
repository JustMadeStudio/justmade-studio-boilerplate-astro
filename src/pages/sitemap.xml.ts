import type { APIRoute } from 'astro';
import { env } from '@/lib/env';
import { isProdRequest, prodHost } from '@/lib/host';
// import { studio, safe } from '@/lib/studio';

/**
 * Dynamic sitemap. Only served on the canonical production host; every other
 * host (preview/staging, raw IP, localhost) gets an empty sitemap so preview
 * URLs never leak into search. Mirrors the indexing guard in middleware.ts.
 *
 * Add your CMS-driven routes below: fetch slugs and push them into `paths`.
 */
export const prerender = false;

const SITE_URL = env('PUBLIC_SITE_URL').replace(/\/$/, '');

export const GET: APIRoute = async ({ url, request }) => {
  const host = prodHost();
  const canonical = SITE_URL || (host ? `https://${host}` : url.origin);

  // Static routes that should always be in the sitemap.
  const paths: string[] = ['/'];

  // ── CMS routes: uncomment and wire up to your collections ──────────────────
  // const posts = await safe(() => studio.dataset('blog', 'posts').list(), []);
  // for (const p of posts) paths.push(`/blog/${p.slug}`);

  const body = isProdRequest(request, url)
    ? xml(canonical, paths)
    : xml(canonical, []); // non-prod host -> empty, nothing indexable

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};

function xml(origin: string, paths: string[]): string {
  const urls = paths
    .map((p) => `  <url><loc>${origin}${p}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
