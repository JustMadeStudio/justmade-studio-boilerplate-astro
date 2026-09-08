/**
 * Boot-time env validation. Fail loud and early with a clear message instead
 * of a cryptic 401 deep inside the first CMS request.
 *
 * Called once from src/lib/studio.ts at module load (i.e. at server boot).
 * In dev it warns; in prod (NODE_ENV=production) a missing required var throws
 * so a broken deploy dies at startup rather than serving half-working pages.
 */

type Rule = { key: string; required: boolean; hint: string };

const RULES: Rule[] = [
  { key: 'JUSTMADE_API_KEY', required: true, hint: 'Content API key from Justmade Studio. Store it as a secret in your host env.' },
  { key: 'JUSTMADE_PROJECT', required: true, hint: 'Project slug in Justmade Studio (also drives the default media bucket).' },
  { key: 'PUBLIC_SITE_URL', required: false, hint: 'Canonical production URL. Without it, nothing is treated as production and the whole site stays noindex.' },
];

function read(key: string): string {
  return (process.env[key] || import.meta.env[key] || '').trim();
}

let checked = false;

export function assertEnv(): void {
  if (checked) return;
  checked = true;

  const isProd = (process.env.NODE_ENV || import.meta.env.MODE) === 'production';
  const missing: Rule[] = RULES.filter((r) => !read(r.key));

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
