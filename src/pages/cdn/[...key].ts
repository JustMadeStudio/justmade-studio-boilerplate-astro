import type { APIRoute } from 'astro';
import sharp from 'sharp';
import { appOrigin, cdnBucket, cdnOrigin } from '@/lib/env';

/**
 * Same-origin media proxy with server-side cloaking, resize + format negotiation.
 *
 * URL shape (public):
 *   /cdn/<uuid>.webp              -> default project bucket
 *   /cdn/<uuid>.webp?w=640        -> + server-side resize to 640px wide
 *   /cdn/<uuid>.webp?w=640&f=avif -> + re-encode to AVIF (or webp/jpeg)
 *   /cdn/sub/dir/<uuid>.png       -> full production path (e.g. agent-uploads)
 *   /cdn/_a/api/files/<uid>       -> app-origin file (rare)
 *
 * The upstream host is hardcoded SERVER-SIDE (via env), never in the client URL.
 * So nothing in the markup/network tab reveals the media comes from Justmade Studio,
 * and there is no SSRF risk: the visitor only supplies a path key, not a host.
 *
 * Format: `?f=avif|webp|jpeg|png` forces an output format. Without it, the route
 * picks the best format the browser accepts (AVIF > WebP > original) from the
 * `Accept` header, and always sends `Vary: Accept` so caches stay correct.
 *
 * Perf: in-memory LRU (24h TTL), width+format-aware ETag/304, `immutable`
 * Cache-Control. Same-origin, so no third-party cookies.
 */

export const prerender = false;

// ─── Config (env-driven) ─────────────────────────────────────────────────────
// Read through env() like src/lib/cdn.ts: a bucket resolved from another source
// than the one the helpers used turns every bare /cdn/<uuid> key into a 502.
const CDN_ORIGIN = cdnOrigin();
const APP_ORIGIN = appOrigin();
const BUCKET = cdnBucket();

// Whitelist of allowed upstream hosts. Anything else -> 403.
const ALLOWED_HOSTS = new Set(
  [CDN_ORIGIN, APP_ORIGIN].map((o) => new URL(o).host),
);

// Cache config
const MAX_ENTRIES = 256;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WIDTH = 2048;

type Fmt = 'avif' | 'webp' | 'jpeg' | 'png';
type Entry = { body: Buffer; type: string; etag: string; at: number };
const cache = new Map<string, Entry>();

function cacheGet(key: string): Entry | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // LRU touch
  cache.delete(key);
  cache.set(key, e);
  return e;
}

function cacheSet(key: string, e: Entry) {
  cache.set(key, e);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Resolve the public key to the real upstream URL.
 * Uses new URL(rel, base) so that traversal (../) stays within the base; the
 * resulting host is then re-checked against the whitelist.
 */
function resolveTarget(key: string): URL | null {
  let base: string;
  let rel: string;

  if (key.startsWith('_a/')) {
    // app-origin file
    base = `${APP_ORIGIN}/`;
    rel = key.slice('_a/'.length);
  } else if (key.includes('/')) {
    // full production path (e.g. agent-uploads/<uuid>.png)
    base = `${CDN_ORIGIN}/production/`;
    rel = key;
  } else {
    // bare key -> default bucket
    base = `${CDN_ORIGIN}/${BUCKET}`;
    rel = key;
  }

  try {
    const u = new URL(rel, base.endsWith('/') ? base : `${base}/`);
    if (!ALLOWED_HOSTS.has(u.host)) return null;
    // Prevent the resolve from escaping the intended origin.
    if (u.origin !== CDN_ORIGIN && u.origin !== APP_ORIGIN) return null;
    return u;
  } catch {
    return null;
  }
}

/** Pick the best output format for this request. */
function pickFormat(explicit: string | null, accept: string): { fmt: Fmt | null; negotiated: boolean } {
  const f = (explicit || '').toLowerCase();
  if (f === 'avif' || f === 'webp' || f === 'jpeg' || f === 'jpg' || f === 'png') {
    return { fmt: (f === 'jpg' ? 'jpeg' : f) as Fmt, negotiated: false };
  }
  // Content negotiation from Accept header.
  if (/image\/avif/.test(accept)) return { fmt: 'avif', negotiated: true };
  if (/image\/webp/.test(accept)) return { fmt: 'webp', negotiated: true };
  // No modern format advertised -> keep re-encoding to webp as a safe default,
  // but mark it negotiated so we Vary on Accept.
  return { fmt: 'webp', negotiated: true };
}

export const GET: APIRoute = async ({ params, request }) => {
  const key = (params.key || '').toString();
  if (!key) return new Response('Not found', { status: 404 });

  const target = resolveTarget(key);
  if (!target) return new Response('Forbidden', { status: 403 });

  // resize width
  const url = new URL(request.url);
  const wParam = url.searchParams.get('w');
  let width = wParam ? parseInt(wParam, 10) : 0;
  if (!Number.isFinite(width) || width <= 0) width = 0;
  if (width > MAX_WIDTH) width = MAX_WIDTH;

  // output format (explicit ?f= or negotiated from Accept)
  const accept = request.headers.get('accept') || '';
  const { fmt, negotiated } = pickFormat(url.searchParams.get('f'), accept);

  const cacheKey = `${target.href}::w${width}::f${fmt ?? 'orig'}`;
  const hit = cacheGet(cacheKey);

  // 304 handling
  const inm = request.headers.get('if-none-match');
  if (hit && inm && inm === hit.etag) {
    return new Response(null, { status: 304, headers: cacheHeaders(hit.type, hit.etag, negotiated) });
  }
  if (hit) {
    return new Response(new Uint8Array(hit.body), { status: 200, headers: cacheHeaders(hit.type, hit.etag, negotiated) });
  }

  // Fetch upstream
  let upstream: Response;
  try {
    upstream = await fetch(target.href, { headers: { accept: 'image/*' } });
  } catch {
    return new Response('Bad gateway', { status: 502 });
  }
  if (!upstream.ok) {
    return new Response('Upstream error', { status: upstream.status === 404 ? 404 : 502 });
  }

  const upstreamType = upstream.headers.get('content-type') || '';
  if (!upstreamType.startsWith('image/')) {
    return new Response('Not an image', { status: 415 });
  }

  const input = Buffer.from(await upstream.arrayBuffer());

  // Resize + re-encode. Leave SVG and GIF untouched (animation / vector).
  let body = input;
  let type = upstreamType;
  const reencodable = /image\/(jpe?g|png|webp|avif|tiff)/.test(upstreamType);
  if (reencodable && fmt) {
    try {
      let pipe = sharp(input, { failOn: 'none' });
      if (width > 0) pipe = pipe.resize({ width, withoutEnlargement: true });
      if (fmt === 'avif') pipe = pipe.avif({ quality: 55 });
      else if (fmt === 'webp') pipe = pipe.webp({ quality: 82 });
      else if (fmt === 'jpeg') pipe = pipe.jpeg({ quality: 82, mozjpeg: true });
      else pipe = pipe.png({ compressionLevel: 9 });
      body = await pipe.toBuffer();
      type = `image/${fmt}`;
    } catch {
      body = input;
      type = upstreamType;
    }
  }

  const etag = `"${hashBuf(body)}"`;
  cacheSet(cacheKey, { body, type, etag, at: Date.now() });

  if (inm && inm === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders(type, etag, negotiated) });
  }
  return new Response(new Uint8Array(body), { status: 200, headers: cacheHeaders(type, etag, negotiated) });
};

function cacheHeaders(type: string, etag: string, vary: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': type,
    'cache-control': 'public, max-age=31536000, immutable',
    etag,
  };
  // When the format was negotiated from Accept, caches must vary on it.
  if (vary) h['vary'] = 'Accept';
  return h;
}

// Fast, non-cryptographic hash for the ETag.
function hashBuf(buf: Buffer): string {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i += 997) {
    h = (h ^ buf[i]) >>> 0;
    h = (h * 16777619) >>> 0;
  }
  return (h >>> 0).toString(36) + '-' + buf.length.toString(36);
}
