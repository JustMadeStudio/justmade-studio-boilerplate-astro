# StudioLayer Astro Boilerplate

Astro SSR + [StudioLayer](https://studiolayer.io) as a headless CMS. The starting point we clone for a new site: fast, env-driven, brandless, ready for prod on day one.

No client name, domain or key is baked in. Set your env, wire up your content, ship.

## Stack

| | |
|---|---|
| **Framework** | Astro, `output: 'server'`, `@astrojs/node` standalone |
| **Styling** | Tailwind 4 via `@tailwindcss/vite` - tokens in `src/styles/app.css` (`@theme`), no config file |
| **CMS** | `@studiolayer/client` |
| **Images** | `sharp` - server-side resize + AVIF/WebP, same-origin proxy |
| **Lang** | TypeScript strict, `@/*` -> `src/*` |

## Quick start

```bash
cp .env.example .env      # fill STUDIOLAYER_API_KEY + STUDIOLAYER_PROJECT
npm install
npm run dev               # http://localhost:4321
```

```bash
npm run build
npm run start             # prod server: node server.mjs
```

Node 22 (see `.nvmrc`).

## Env

| Var | Required | What |
|---|---|---|
| `STUDIOLAYER_API_KEY` | yes | Content API key. Store as a secret in your host env, never in the repo. |
| `STUDIOLAYER_PROJECT` | yes | Project slug. Also drives the default media bucket. |
| `PUBLIC_SITE_URL` | prod | Canonical URL. Without it nothing is treated as production and the site stays `noindex`. |
| `STUDIOLAYER_BASE_URL` | no | App origin. Defaults to `https://app.studiolayer.io`. |
| `STUDIOLAYER_CDN_ORIGIN` | no | Media CDN origin. Server-side only. |
| `STUDIOLAYER_CDN_BUCKET` | no | Override the default bucket prefix. |

`assertEnv()` runs at boot: it throws in production when a required var is missing, so a broken deploy dies at startup instead of serving half a site. In dev it just warns.

## Content

```ts
import { studio, safe } from '@/lib/studio';

// Always wrap reads in safe() - a CMS hiccup degrades to the fallback, no 500.
const posts = await safe(() => studio.dataset('blog', 'posts').list(), []);
const page  = await safe(() => studio.dataset('site', 'pages').get(uid), null);
```

## Images

Everything goes through `/cdn/<key>` - same origin, so the markup never exposes the StudioLayer backend, and the proxy resizes + re-encodes (AVIF/WebP) and caches hard.

```ts
import { cdn } from '@/lib/studio';

cdn(url)                        // /cdn/<uuid>.webp
cdn(url, 640)                   // + resize to 640px
cdn(url, { w: 1280, f: 'avif' })// + force AVIF
```

`cdn()` is the primitive - use it anywhere a URL goes (`img` src, background-image, `og:image`, preload). Two components sit on top:

```astro
---
import CdnImage from '@/components/CdnImage.astro';
import CdnSource from '@/components/CdnSource.astro';
---
<!-- responsive <img>, auto srcset. priority = LCP/above-the-fold -->
<CdnImage src={post.cover} alt={post.title} width={960} sizes="(min-width:768px) 50vw, 100vw" priority />

<!-- AVIF -> WebP fallback via <picture> -->
<picture>
  <CdnSource src={post.cover} format="avif" widths={[640, 960, 1280]} sizes="50vw" />
  <CdnSource src={post.cover} format="webp" widths={[640, 960, 1280]} sizes="50vw" />
  <CdnImage  src={post.cover} alt={post.title} width={960} />
</picture>
```

Output format is negotiated per request (AVIF > WebP from `Accept`) unless you pin it. The proxy allowlists upstream hosts, clamps resize width, and varies its cache on format - no open-proxy or SSRF surface.

## Indexing

Only the canonical `PUBLIC_SITE_URL` host is indexable. Every other host - preview deploys, staging, raw IPs, localhost - is forced `noindex` at three levels: `X-Robots-Tag` header (`middleware.ts`), crawl policy (`robots.txt`), and meta tag (`Base.astro`). Preview URLs stay out of search by default. The single source of truth is `isProdRequest()` in `src/lib/host.ts`.

`robots.txt`, `sitemap.xml` and a `/health` liveness probe are all dynamic routes.

## SEO gate

`npm run build` ends with `scripts/seo-gate.mjs`, so a build with a real SEO fault fails and never deploys. It boots the freshly built server on a loopback port, pretends to be the canonical host (otherwise the indexing guard noindexes everything), then crawls `robots.txt`, `sitemap.xml` and the pages the sitemap lists.

The split is deliberate: **machine-objective and indexing-determining is a fail, quality and interpretation is a warn.** A gate that fails on a 62-character title gets switched off within a week, and then it catches nothing.

| Blocks the build | Reported for review |
| --- | --- |
| `PUBLIC_SITE_URL` unset (whole site would be noindex) | `<title>` outside 15-60 characters |
| canonical missing, or not self-referencing | meta description missing or outside 120-160 |
| a `noindex` page that the sitemap still lists | `<img>` without `alt` (decorative images live here too) |
| `robots.txt` not 200, or disallowing its own sitemap | missing Open Graph / Twitter tags |
| more than one `<h1>`, or none | no `hreflang` once the site serves several languages |
| JSON-LD that does not parse | |
| `<title>` missing entirely | |
| a sitemap URL that does not answer 200 | |

```bash
npm run seo:gate            # run it against the current build
SEO_GATE=off npm run build  # escape hatch, use knowingly
SEO_GATE_MAX_PAGES=100      # crawl deeper than the default 25
```

Pass `PUBLIC_SITE_URL` as a build arg (the Dockerfile takes one), or the gate fails the image build. Without CMS credentials at build time the gate still runs and checks page structure, with content unavailable.

This is layer 1. Everything a script cannot judge - keyword mapping, URL structure, internal linking, schema choice - is layer 2: a human SEO review that blocks go-live separately.

## Layout

```
src/
  lib/        studio (CMS + safe), cdn (cloak helpers), host (indexing), env
  pages/      cdn/[...key], robots.txt, sitemap.xml, health, 404, index
  components/ CdnImage, CdnSource
  layouts/    Base (head, OG, sl.js embed)
  styles/     app.css (Tailwind 4 @theme tokens)
  middleware.ts   security headers + CSP + indexing guard
scripts/
  seo-gate.mjs  postbuild SEO gate (blocks the build on an indexing fault)
server.mjs    prod server (immutable cache on hashed assets)
Dockerfile    multi-stage build + healthcheck
```

## Deploy

Any host that runs a container or a node process. Build the image, set the env, expose port `4321`. The container ships only `dist/`, `node_modules`, `server.mjs` and `package.json` - **never `src/`**, so server-side routes must not read from the filesystem (put runtime assets in `public/`).

## For agents

`AGENTS.md` holds the hard rules (SSR-only, media through `/cdn/`, don't break the indexing guard, keep the `sl.js` embed) and a definition-of-done checklist. Read it before editing.

## Docs

- Astro: https://docs.astro.build/en/getting-started/
- Astro node adapter (SSR): https://docs.astro.build/en/guides/integrations-guide/node/
- StudioLayer: https://studiolayer.io
- Tailwind 4: https://tailwindcss.com/docs
