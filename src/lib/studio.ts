/**
 * Justmade Studio headless CMS client.
 *
 * Uses @justmade/client. Config is fully env-driven:
 *   JUSTMADE_API_KEY   - Content API key (store as a secret)
 *   JUSTMADE_BASE_URL  - app origin (default https://studio.justmade.be)
 *
 * Reads target a node + dataset: `studio.dataset('<node>', '<dataset>')`.
 * Media/cloaking helpers live in src/lib/cdn.ts; they are re-exported here for
 * convenience (`import { cdn } from '@/lib/studio'` keeps working).
 */
import { createClient } from '@justmade/client';
import { assertEnv } from './env';

// Validate env at boot: throws in prod when a required var is missing, warns in dev.
assertEnv();

const BASE_URL = import.meta.env.JUSTMADE_BASE_URL || 'https://studio.justmade.be';
const API_KEY = import.meta.env.JUSTMADE_API_KEY;

export const studio = createClient({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
});

export function clearStudioCache() {
  studio.clearCache();
}

/**
 * Safety net around any CMS read. If Justmade Studio hiccups, a single call should
 * degrade to a fallback (empty list / null) instead of throwing a 500 and
 * taking the whole page down. Logs the error so it is still visible.
 *
 *   const posts = await safe(() => studio.dataset('blog', 'posts').list(), []);
 *   const page  = await safe(() => studio.dataset('site', 'pages').get(uid), null);
 */
export async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error('[studio] CMS read failed, using fallback:', err);
    return fallback;
  }
}

// Re-export the media-cloaking helpers so existing imports keep working.
export { cdn, cdnSrcSet, isProxyable, proxied, imgAtWidth, srcSet, type CdnFormat, type CdnOpts } from './cdn';
