#!/usr/bin/env node
/**
 * SEO gate - layer 1 of the pre-launch SEO check.
 *
 * Runs as `postbuild`, so a real SEO fault fails the build and the site never
 * deploys. This is the only hard "must" in the SEO workflow: everything a
 * script cannot judge (keyword mapping, URL structure, internal linking, schema
 * choice) is layer 2, a human review that blocks go-live separately.
 *
 * The line between the two is: MACHINE-OBJECTIVE AND INDEXING-DETERMINING is a
 * fail. Quality and interpretation are a warn. A gate that fails on a
 * 62-character title gets switched off within a week, and then it catches
 * nothing at all.
 *
 * This site is SSR, so there is no folder of .html files to grep. The gate
 * boots the freshly built server on a loopback port and crawls it over HTTP,
 * which is also the only honest way to test it: canonical, robots.txt, sitemap
 * and the noindex guard are all computed per request from the host.
 *
 * Requests carry `x-forwarded-host: <PUBLIC_SITE_URL host>`, because the whole
 * site is deliberately noindex on any host that is not the canonical one
 * (src/lib/host.ts). Crawling localhost without it would test the preview
 * behaviour and report a fully noindexed site every time.
 *
 *   npm run seo:gate      run it by hand against the current build
 *   SEO_GATE=off          skip it entirely (escape hatch, use knowingly)
 *   SEO_GATE_MAX_PAGES=n  cap the crawl (default 25)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';

const MAX_PAGES = Number(process.env.SEO_GATE_MAX_PAGES) || 25;
const BOOT_TIMEOUT_MS = 30_000;

// ── The assertion list ───────────────────────────────────────────────────────
// Kept as data so this file doubles as the spec. `level: 'fail'` blocks the
// deploy; `level: 'warn'` is reported and reviewed by hand.
//
// fail:
//   canonical-missing        canonical absent, or not self-referencing, on an indexable page
//   noindex-in-sitemap       a page marked noindex that the sitemap still lists
//   robots-unreachable       robots.txt does not answer 200
//   robots-blocks-sitemap    robots.txt disallows the sitemap it advertises
//   h1-count                 more than one <h1>, or none
//   jsonld-invalid           a JSON-LD block does not parse
//   title-missing            no <title> at all
//   sitemap-status           the sitemap URL does not answer 200
//   site-url-missing         PUBLIC_SITE_URL unset, so nothing is indexable at all
//
// warn:
//   title-length             <title> outside 15-60 characters
//   description-missing      no meta description
//   description-length       meta description outside 120-160 characters
//   img-alt                  <img> without alt (decorative images live here too)
//   social-tags              missing Open Graph / Twitter card tags
//   hreflang-missing         more than one <html lang> across the site, no hreflang

const TITLE_MIN = 15;
const TITLE_MAX = 60;
const DESC_MIN = 120;
const DESC_MAX = 160;

const failures = [];
const warnings = [];
const fail = (rule, where, detail) => failures.push({ rule, where, detail });
const warn = (rule, where, detail) => warnings.push({ rule, where, detail });

// ── Tiny HTML helpers ────────────────────────────────────────────────────────
// Regex, deliberately: this gate must run in a bare build container with no
// extra dependency to install. It only ever looks at head tags and counts h1s,
// which regex handles fine; anything needing a real tree belongs in layer 2.

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : null;
};

const tagsNamed = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];

function metaContent(html, { name, property }) {
  for (const tag of tagsNamed(html, 'meta')) {
    const key = name ? attr(tag, 'name') : attr(tag, 'property');
    if (key && key.toLowerCase() === (name || property).toLowerCase()) return attr(tag, 'content') ?? '';
  }
  return null;
}

function linkHref(html, rel) {
  for (const tag of tagsNamed(html, 'link')) {
    if ((attr(tag, 'rel') || '').toLowerCase() === rel) return attr(tag, 'href');
  }
  return null;
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// ── Boot the built server on a loopback port ─────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForBoot(port, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited with code ${child.exitCode} before it was reachable`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the server did not answer /health within ${BOOT_TIMEOUT_MS / 1000}s`);
}

/**
 * Start the built server on a loopback port. Probing for a free port and then
 * handing it to a child process is inherently racy - the OS can lease the same
 * ephemeral port to something else in between - so a lost race is retried on a
 * fresh port instead of failing the build for a reason that has nothing to do
 * with SEO.
 */
async function bootServer(attempts = 4) {
  let lastError;
  // The server refuses to serve a single request without CMS credentials, and a
  // build container often has none. This gate reads document structure, not
  // content, so it stands in a placeholder rather than refusing to check
  // anything: the CMS calls then fail into the `safe()` fallbacks and pages
  // still render their layout. Where the real credentials ARE present (a
  // Coolify build with its env attached) they are used untouched and the gate
  // sees the real pages.
  const cmsStub = {};
  for (const key of ['STUDIOLAYER_API_KEY', 'STUDIOLAYER_PROJECT']) {
    if (!(process.env[key] || '').trim()) cmsStub[key] = 'seo-gate-placeholder';
  }
  if (Object.keys(cmsStub).length) {
    console.warn(`[seo-gate] ${Object.keys(cmsStub).join(', ')} not set - checking page structure with CMS content unavailable.`);
  }

  for (let i = 0; i < attempts; i++) {
    const port = await freePort();
    const log = [];
    const child = spawn(process.execPath, ['./server.mjs'], {
      env: { ...process.env, ...cmsStub, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => log.push(d.toString()));
    child.stderr.on('data', (d) => log.push(d.toString()));

    try {
      await waitForBoot(port, child);
      return { port, child, log };
    } catch (err) {
      child.kill('SIGTERM');
      lastError = err;
      if (log.join('').includes('EADDRINUSE')) continue;
      err.serverLog = log.join('').trim();
      throw err;
    }
  }
  lastError.serverLog = `could not find a free port after ${attempts} attempts`;
  throw lastError;
}

// ── Per-page checks ──────────────────────────────────────────────────────────

async function checkPage(get, path, canonicalOrigin, langs) {
  const res = await get(path);
  const where = path;

  if (!res.ok) {
    fail('sitemap-status', where, `listed in the sitemap but answered ${res.status}`);
    return;
  }

  const html = await res.text();

  // Indexability first: it decides whether the rest is even meaningful.
  const robotsMeta = (metaContent(html, { name: 'robots' }) || '').toLowerCase();
  const robotsHeader = (res.headers.get('x-robots-tag') || '').toLowerCase();
  const noindex = robotsMeta.includes('noindex') || robotsHeader.includes('noindex');
  if (noindex) {
    // The sitemap is a list of pages asking to be indexed. A noindex page on it
    // is a straight contradiction, and the kind search engines punish.
    fail('noindex-in-sitemap', where, `noindex (${robotsMeta || robotsHeader}) but the sitemap lists it`);
  }

  // Canonical: absent or pointing elsewhere silently splits or hands away the page.
  const canonical = linkHref(html, 'canonical');
  const expected = new URL(path, canonicalOrigin).href;
  if (!canonical) {
    if (!noindex) fail('canonical-missing', where, 'no <link rel="canonical">');
  } else if (canonical.replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
    if (!noindex) fail('canonical-missing', where, `canonical points at ${canonical}, expected ${expected}`);
  }

  // Exactly one h1.
  const h1s = (html.match(/<h1\b/gi) || []).length;
  if (h1s !== 1) fail('h1-count', where, h1s === 0 ? 'no <h1> on the page' : `${h1s} <h1> elements, expected exactly 1`);

  // Structured data must at least be valid JSON.
  jsonLdBlocks(html).forEach((raw, i) => {
    try {
      JSON.parse(raw);
    } catch (err) {
      fail('jsonld-invalid', where, `JSON-LD block ${i + 1} does not parse: ${err.message}`);
    }
  });

  // Title: missing is a fail, badly sized is a warn.
  const title = titleOf(html);
  if (!title) fail('title-missing', where, 'no <title>');
  else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    warn('title-length', where, `<title> is ${title.length} chars, aim for ${TITLE_MIN}-${TITLE_MAX}: "${title}"`);
  }

  const desc = metaContent(html, { name: 'description' });
  if (desc === null || desc === '') warn('description-missing', where, 'no meta description');
  else if (desc.length < DESC_MIN || desc.length > DESC_MAX) {
    warn('description-length', where, `meta description is ${desc.length} chars, aim for ${DESC_MIN}-${DESC_MAX}`);
  }

  // Alt text is a warn, not a fail: a decorative image legitimately has alt="",
  // and this check cannot tell decorative from missing.
  const noAlt = tagsNamed(html, 'img').filter((t) => attr(t, 'alt') === null).length;
  if (noAlt > 0) warn('img-alt', where, `${noAlt} <img> without an alt attribute`);

  const social = [
    ['og:title', metaContent(html, { property: 'og:title' })],
    ['og:description', metaContent(html, { property: 'og:description' })],
    ['og:image', metaContent(html, { property: 'og:image' })],
    ['twitter:card', metaContent(html, { name: 'twitter:card' })],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (social.length) warn('social-tags', where, `missing ${social.join(', ')}`);

  const lang = (html.match(/<html\b[^>]*>/i)?.[0] && attr(html.match(/<html\b[^>]*>/i)[0], 'lang')) || '';
  if (lang) langs.add(lang.toLowerCase());
  const hasHreflang = tagsNamed(html, 'link').some((t) => attr(t, 'hreflang'));
  return { path, lang: lang.toLowerCase(), hasHreflang };
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  if ((process.env.SEO_GATE || '').toLowerCase() === 'off') {
    console.log('[seo-gate] SEO_GATE=off - skipped.');
    return 0;
  }

  const siteUrl = (process.env.PUBLIC_SITE_URL || '').trim().replace(/\/$/, '');
  if (!siteUrl) {
    console.error('[seo-gate] FAIL site-url-missing: PUBLIC_SITE_URL is not set.');
    console.error('           Without it every page is served noindex and robots.txt disallows everything,');
    console.error('           so the whole site is invisible to search. Set it, or set SEO_GATE=off if this');
    console.error('           build is deliberately not a production one.');
    return 1;
  }

  let canonicalOrigin;
  let prodHost;
  try {
    const u = new URL(siteUrl);
    canonicalOrigin = u.origin;
    prodHost = u.host;
  } catch {
    console.error(`[seo-gate] FAIL site-url-missing: PUBLIC_SITE_URL is not a valid URL: "${siteUrl}"`);
    return 1;
  }

  if (!existsSync('./dist/server/entry.mjs')) {
    console.error('[seo-gate] No build found at dist/server/entry.mjs. Run `npm run build` first.');
    return 1;
  }

  let port, child;
  try {
    ({ port, child } = await bootServer());
  } catch (err) {
    console.error(`[seo-gate] could not start the built server: ${err.message}`);
    if (err.serverLog) console.error(err.serverLog);
    return 1;
  }

  // Every request pretends to arrive on the canonical host, so the indexing
  // guard behaves the way it will in production instead of blanket-noindexing.
  const get = (path) => fetch(new URL(path, `http://127.0.0.1:${port}`), {
    headers: { 'x-forwarded-host': prodHost, 'x-forwarded-proto': 'https' },
    redirect: 'manual',
  });

  try {
    // robots.txt
    const robotsRes = await get('/robots.txt');
    let robots = '';
    if (!robotsRes.ok) {
      fail('robots-unreachable', '/robots.txt', `answered ${robotsRes.status}`);
    } else {
      robots = await robotsRes.text();
      // A blanket disallow that also covers the sitemap it advertises means the
      // crawler is told to fetch a URL it is forbidden to fetch.
      const disallowsAll = /^\s*disallow:\s*\/\s*$/im.test(robots);
      const advertisesSitemap = /^\s*sitemap:\s*\S+/im.test(robots);
      if (disallowsAll && advertisesSitemap) {
        fail('robots-blocks-sitemap', '/robots.txt', 'advertises a sitemap while disallowing the whole site');
      } else if (disallowsAll) {
        fail('robots-blocks-sitemap', '/robots.txt', `Disallow: / on the production host (${prodHost}) - nothing can be crawled`);
      }
    }

    // sitemap.xml
    const sitemapRes = await get('/sitemap.xml');
    let paths = [];
    if (!sitemapRes.ok) {
      fail('sitemap-status', '/sitemap.xml', `answered ${sitemapRes.status}`);
    } else {
      const xml = await sitemapRes.text();
      paths = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
        .map((m) => {
          try {
            return new URL(m[1]).pathname;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (paths.length === 0) {
        fail('sitemap-status', '/sitemap.xml', `contains no URLs on the production host (${prodHost}) - search has nothing to find`);
      }
    }

    const crawl = paths.slice(0, MAX_PAGES);
    if (paths.length > crawl.length) {
      console.log(`[seo-gate] sitemap lists ${paths.length} URLs, checking the first ${crawl.length} (SEO_GATE_MAX_PAGES).`);
    }

    const langs = new Set();
    const pages = [];
    for (const path of crawl) pages.push(await checkPage(get, path, canonicalOrigin, langs));

    // hreflang only means anything once a site actually serves more than one
    // language, so it is judged across the crawl rather than per page.
    if (langs.size > 1) {
      const missing = pages.filter((p) => p && !p.hasHreflang);
      if (missing.length) {
        warn('hreflang-missing', `${missing.length} page(s)`, `the site serves ${[...langs].join(', ')} but these carry no hreflang links`);
      }
    }
  } catch (err) {
    console.error(`[seo-gate] could not check the build: ${err.message}`);
    return 1;
  } finally {
    child.kill('SIGTERM');
  }

  // ── Report ────────────────────────────────────────────────────────────────
  for (const w of warnings) console.warn(`[seo-gate] WARN  ${w.rule} ${w.where}: ${w.detail}`);
  for (const f of failures) console.error(`[seo-gate] FAIL  ${f.rule} ${f.where}: ${f.detail}`);

  if (failures.length) {
    console.error(`\n[seo-gate] ${failures.length} blocking SEO fault(s). This build does not deploy.`);
    console.error('[seo-gate] These are indexing faults, not style notes: fix them, or set SEO_GATE=off if you');
    console.error('[seo-gate] genuinely mean to ship a site search cannot read.');
    return 1;
  }

  const tail = warnings.length ? ` ${warnings.length} warning(s) for review.` : '';
  console.log(`[seo-gate] passed on ${canonicalOrigin}.${tail}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[seo-gate] crashed:', err);
  process.exit(1);
});
