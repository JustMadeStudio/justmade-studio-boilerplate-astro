/**
 * Media cloaking helpers for the same-origin proxy at /cdn/<key>.
 *
 * Why route media through /cdn/:
 *   1. The markup only ever contains /cdn/<uuid>.webp - visitors never see that
 *      the media comes from an external CDN (Justmade Studio).
 *   2. Same-origin: no extra DNS/TLS handshake, no third-party cookies, and the
 *      proxy resizes + re-encodes server-side (WebP/AVIF) and caches hard.
 *
 * The key shape MUST match resolveTarget() in src/pages/cdn/[...key].ts:
 *   - bare "<uuid>.webp"            -> default project bucket
 *   - "sub/dir/<uuid>.png"          -> full production path (e.g. agent-uploads)
 *   - "_a/api/files/<uid>"          -> app-origin file (rare)
 *
 * `cdn()` is the primitive: use it anywhere a URL goes (img src, background-image,
 * <link rel=preload>, og:image). <CdnImage>/<CdnSource> are ergonomic wrappers.
 */

import { appOrigin, cdnBucket, cdnOrigin } from './env';

// Same source as the /cdn/ route (src/lib/env.ts), so the key this file emits
// and the bucket the route resolves it against can never disagree.
const CDN_PREFIX = `${cdnOrigin()}/${cdnBucket()}`;
const CDN_ROOT = `${cdnOrigin()}/production/`;
const APP_PREFIX = `${appOrigin()}/`;
const ROUTE = '/cdn/';

export type CdnFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export interface CdnOpts {
  /** Resize to this width (px). Omitted = original width. */
  w?: number;
  /** Force output format. Omitted = negotiated from the browser's Accept header. */
  f?: CdnFormat;
}

/** True when the URL can be served through the /cdn/ proxy. */
export function isProxyable(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(ROUTE)) return true;
  return url.startsWith(CDN_PREFIX) || url.startsWith(CDN_ROOT) || url.startsWith(`${APP_PREFIX}api/files/`);
}

/** Map an absolute CMS/CDN URL to its same-origin /cdn/ key (without leading route). */
function toKey(url: string): string | null {
  if (url.startsWith(ROUTE)) return url.slice(ROUTE.length).split('?')[0];
  if (url.startsWith(CDN_PREFIX)) return url.slice(CDN_PREFIX.length);
  if (url.startsWith(CDN_ROOT)) return url.slice(CDN_ROOT.length);
  if (url.startsWith(`${APP_PREFIX}api/files/`)) {
    return '_a/api/files/' + url.slice(`${APP_PREFIX}api/files/`.length);
  }
  return null;
}

/**
 * The primitive. Turn any CMS/CDN URL into a same-origin /cdn/ URL, optionally
 * resized (`w`) and/or re-encoded (`f`). Unknown origins and already-relative
 * URLs are returned unchanged so it is always safe to wrap a src in cdn().
 *
 *   cdn(url)                       -> /cdn/<uuid>.webp
 *   cdn(url, 640)                  -> /cdn/<uuid>.webp?w=640
 *   cdn(url, { w: 640, f: 'avif' })-> /cdn/<uuid>.webp?w=640&f=avif
 */
export function cdn(url: string | null | undefined, opts?: number | CdnOpts): string {
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith(ROUTE)) return url; // already relative

  const key = toKey(url);
  if (key === null) return url; // unknown origin, leave untouched

  const o: CdnOpts = typeof opts === 'number' ? { w: opts } : opts || {};
  const qs = new URLSearchParams();
  if (o.w && o.w > 0) qs.set('w', String(Math.round(o.w)));
  if (o.f) qs.set('f', o.f);
  const q = qs.toString();
  return `${ROUTE}${key}${q ? `?${q}` : ''}`;
}

/** Build a width-based srcset for a given format (or negotiated when f omitted). */
export function cdnSrcSet(
  url: string | null | undefined,
  widths: number[] = [320, 480, 640, 960, 1280],
  f?: CdnFormat,
): string {
  if (!isProxyable(url)) return '';
  return widths.map((w) => `${cdn(url, { w, f })} ${w}w`).join(', ');
}
