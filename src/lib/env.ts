/**
 * The one way this site reads its config, plus the boot-time check.
 *
 * Why `env()` instead of `import.meta.env.X` or `process.env.X`:
 *   - Vite INLINES `import.meta.env.X` at build time. A secret that only exists
 *     in the container's runtime env (a Coolify secret) would be baked in as
 *     whatever the build saw, usually nothing, and the site boots without a key.
 *   - Under `astro dev` the .env file only lands on `import.meta.env`, never on
 *     `process.env`.
 * So: runtime `process.env` first, then the build/dev value. Every module reads
 * through here, so the CMS client, the media helpers and the /cdn/ proxy can
 * never resolve the same setting from two different sources.
 *
 * The build-time values are listed as static `import.meta.env.X` members on
 * purpose: Vite only replaces the literal member form, a dynamic
 * `import.meta.env[key]` is not guaranteed to be populated in the build output.
 */

const BUILD_ENV: Record<string, string | undefined> = {
  JUSTMADE_API_KEY: import.meta.env.JUSTMADE_API_KEY,
  JUSTMADE_PROJECT: import.meta.env.JUSTMADE_PROJECT,
  JUSTMADE_BASE_URL: import.meta.env.JUSTMADE_BASE_URL,
  JUSTMADE_CDN_ORIGIN: import.meta.env.JUSTMADE_CDN_ORIGIN,
  JUSTMADE_CDN_BUCKET: import.meta.env.JUSTMADE_CDN_BUCKET,
  PUBLIC_SITE_URL: import.meta.env.PUBLIC_SITE_URL,
};

export type EnvKey =
  | 'JUSTMADE_API_KEY'
  | 'JUSTMADE_PROJECT'
  | 'JUSTMADE_BASE_URL'
  | 'JUSTMADE_CDN_ORIGIN'
  | 'JUSTMADE_CDN_BUCKET'
  | 'PUBLIC_SITE_URL';

/** A config value, trimmed; '' when unset. Server-side only. */
export function env(key: EnvKey): string {
  const runtime = typeof process !== 'undefined' ? process.env[key] : undefined;
  return (runtime || BUILD_ENV[key] || '').trim();
}

/** App origin of the studio, without a trailing slash. */
export const appOrigin = (): string =>
  (env('JUSTMADE_BASE_URL') || 'https://studio.justmade.be').replace(/\/$/, '');

/** Media CDN origin, without a trailing slash. Server-side only, never in the markup. */
export const cdnOrigin = (): string =>
  (env('JUSTMADE_CDN_ORIGIN') || 'https://cdn.studiolayer.io').replace(/\/$/, '');

/** Bucket prefix a bare /cdn/<uuid> key resolves against, with a trailing slash. */
export function cdnBucket(): string {
  const project = env('JUSTMADE_PROJECT');
  return (env('JUSTMADE_CDN_BUCKET') || (project ? `production/projects/${project}/` : 'production/')).replace(/^\/+/, '');
}

/**
 * Boot-time env validation. Fail loud and early with a clear message instead
 * of a cryptic 401 deep inside the first CMS request.
 *
 * Called from src/middleware.ts and src/lib/studio.ts at module load (i.e. at
 * server boot). In dev it warns; in prod (NODE_ENV=production) a missing
 * required var throws so a broken deploy dies at startup rather than serving
 * half-working pages.
 */

type Rule = { key: EnvKey; required: boolean; hint: string };

const RULES: Rule[] = [
  { key: 'JUSTMADE_API_KEY', required: true, hint: 'Content API key from Justmade Studio. Store it as a secret in your host env.' },
  { key: 'JUSTMADE_PROJECT', required: true, hint: 'Project slug in Justmade Studio (also drives the default media bucket).' },
  { key: 'PUBLIC_SITE_URL', required: false, hint: 'Canonical production URL. Without it, nothing is treated as production and the whole site stays noindex.' },
];

let checked = false;

export function assertEnv(): void {
  if (checked) return;
  checked = true;

  const isProd = (process.env.NODE_ENV || import.meta.env.MODE) === 'production';
  const missing: Rule[] = RULES.filter((r) => !env(r.key));

  if (missing.length === 0) return;

  const lines = missing.map((r) => `  - ${r.key}${r.required ? ' (required)' : ' (optional)'}: ${r.hint}`);
  const msg = `[env] Missing environment variables:\n${lines.join('\n')}`;

  const hardFail = isProd && missing.some((r) => r.required);
  if (hardFail) {
    // Kill the boot: a prod deploy without an API key must not come up.
    throw new Error(`${msg}\n\nRefusing to start in production without required env.`);
  }
  console.warn(`${msg}\n(dev mode: continuing, CMS calls will fail until set)`);
}
