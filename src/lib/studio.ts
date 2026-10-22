/**
 * Justmade Studio headless CMS client.
 *
 * Uses @justmade/client. Config is fully env-driven (read through env(), see
 * src/lib/env.ts for why):
 *   JUSTMADE_API_KEY   - Content API key (store as a secret)
 *   JUSTMADE_BASE_URL  - app origin (default https://studio.justmade.be)
 *
 * Reads target a node + dataset: `studio.dataset('<node>', '<dataset>')`.
 * Media/cloaking helpers live in src/lib/cdn.ts and the inline-editor
 * attributes in src/lib/edit.ts; both are re-exported here for convenience.
 */
import { createClient } from '@justmade/client';
import { appOrigin, assertEnv, env } from './env';

// Validate env at boot: throws in prod when a required var is missing, warns in dev.
assertEnv();

export const studio = createClient({
  baseUrl: appOrigin(),
  apiKey: env('JUSTMADE_API_KEY'),
  // Dev: no cache, every read hits the studio so an edit shows on refresh.
  // Prod keeps the client defaults: reads revalidate against the project's
  // content stamp at most once a minute, and the 7-day TTL is only the window
  // in which the last good content keeps being served while the studio is down.
  cache: !import.meta.env.DEV,
});

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

export { cdn, cdnSrcSet, isProxyable, type CdnFormat, type CdnOpts } from './cdn';
export { slContent, slCollection, slItem } from './edit';
