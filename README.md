# Justmade Studio Astro Boilerplate

Astro SSR + [Justmade Studio](https://studio.justmade.be) as a headless CMS. The starting point we clone for a new site: fast, env-driven, brandless, ready for prod on day one.

No client name, domain or key is baked in. Set your env, wire up your content, ship.

## Stack

| | |
|---|---|
| **Framework** | Astro, `output: 'server'`, `@astrojs/node` standalone |
| **Styling** | Tailwind 4 via `@tailwindcss/vite` - tokens in `src/styles/app.css` (`@theme`), no config file |
| **CMS** | `@justmade/client` |
| **Images** | `sharp` - server-side resize + AVIF/WebP, same-origin proxy |
| **Lang** | TypeScript strict, `@/*` -> `src/*` |

## Quick start

```bash
cp .env.example .env      # fill JUSTMADE_API_KEY + JUSTMADE_PROJECT
npm install
npm run dev               # http://localhost:4321
```

```bash
npm run build
npm run start             # prod server: node server.mjs
```

Node 22.23.4 or newer (see `.nvmrc`; Astro 7.4 requires it).

## Env

| Var | Required | What |
|---|---|---|
| `JUSTMADE_API_KEY` | yes | Content API key. Store as a secret in your host env, never in the repo. |
| `JUSTMADE_PROJECT` | yes | Project slug. Also drives the default media bucket. |
| `PUBLIC_SITE_URL` | prod | Canonical URL. Without it nothing is treated as production and the site stays `noindex`. |
| `JUSTMADE_BASE_URL` | no | App origin. Defaults to `https://studio.justmade.be`. |
| `JUSTMADE_CDN_ORIGIN` | no | Media CDN origin. Server-side only. |
| `JUSTMADE_CDN_BUCKET` | no | Override the default bucket prefix. |

`assertEnv()` runs at boot: it throws in production when a required var is missing, so a broken deploy dies at startup instead of serving half a site. In dev it just warns.

Read config through `env()` from `src/lib/env.ts`, never `import.meta.env.X` directly: Vite inlines that at build time, so a secret that only exists in the container's runtime env would be baked in as empty. `env()` reads the runtime value first, then the build/dev one.

## Content

```ts
import { studio, safe } from '@/lib/studio';

// Always wrap reads in safe() - a CMS hiccup degrades to the fallback, no 500.
const posts = await safe(() => studio.dataset('blog', 'posts').list(), []);
const page  = await safe(() => studio.dataset('site', 'pages').get(uid), null);
```

In dev the client cache is off, so an edit in the studio shows on the next refresh. In production every read revalidates against the project's content stamp at most once a minute: edits go live on their own, no publish step, no webhook.

### Languages

`@justmade/client` reads in any language the project offers; untranslated fields fall back to the default language, never a blank.

```ts
const locales = await safe(() => studio.locales(), []);           // default first
const posts = await safe(() => studio.dataset('blog', 'posts').list({ locale: 'en' }), []);
```

The studio resolves what you pass (`en`, `en-GB` and `en-US` all reach a configured `en-US`), so the locale can come straight from your URL or `Accept-Language`. Pass the same locale to `<Base lang={...}>` so `<html lang>` matches the copy, and add `hreflang` links once the site serves several languages (the SEO gate reports it).

## Inline editing

The studio edits a site **on the site**: the team in a Surface preview, the customer in the client portal's visual editor. Both load the site in an iframe, where the `sl.js` embed (injected by `Base.astro`, dormant outside an iframe) makes every tagged element editable. What you do not tag, nobody can edit from the page.

```astro
---
import { slContent, slCollection, slItem } from '@/lib/studio';
---
<h1 {...slContent('site', 'home', 'title')}>{home.data.title}</h1>

<ul {...slCollection('blog', 'posts')}>
  {posts.map((p) => (
    <li {...slItem(p.uid)}>
      <h2 {...slContent('blog', 'posts', 'title', p.uid)}>{p.data.title}</h2>
    </li>
  ))}
</ul>
```

- `slContent(node, dataset, field, recordUid?)` - leave the uid out for a single dataset, a collection needs it. Fields nest and index: `seo.title`, `tags[0]`, `members[1].name`.
- The tagged element must render the **raw** value. A formatted date, an excerpt or rendered markdown binds read-only, because writing the rendered text back would corrupt the record.
- One path on one element; a value rendered twice is tagged once.
- `slCollection` + `slItem` let people add, delete and reorder records from the page. Reordering is only offered when the page shows the stored order.
- Inline text editing covers text, plain textarea, email, url and number fields. A single image field is swapped in place; a gallery entry is changed in the CMS (the editor matches gallery images on their CDN URL, which `/cdn/` hides).

## Images

Everything goes through `/cdn/<key>` - same origin, so the markup never exposes the Justmade Studio backend, and the proxy resizes + re-encodes (AVIF/WebP) and caches hard.

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
SEO_GATE_STRICT=1           # a missing PUBLIC_SITE_URL fails instead of skipping
```

Pass `PUBLIC_SITE_URL` as a build arg (the Dockerfile takes one), or the gate fails the image build: the Dockerfile sets `SEO_GATE_STRICT=1`. A local `npm run build` without `PUBLIC_SITE_URL` skips the gate with a warning instead; run `PUBLIC_SITE_URL=https://example.com npm run build` to check it locally. Without CMS credentials at build time the gate still runs and checks page structure, with content unavailable.

This is layer 1. Everything a script cannot judge - keyword mapping, URL structure, internal linking, schema choice - is layer 2: a human SEO review that blocks go-live separately.

## Layout

```
src/
  lib/        studio (CMS + safe), cdn (cloak helpers), edit (inline-editor tags), host (indexing), env
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

Any host that runs a container or a node process. Build the image, set the env, expose port `4321`. The image installs with `npm ci`, so commit `package-lock.json` written by npm 10 (Node 22, see `.nvmrc`): a lockfile from a newer npm major can fail `npm ci` on the build. It ships `curl` because Coolify ignores the Dockerfile `HEALTHCHECK` and probes `/health` with curl itself. The container ships only `dist/`, `node_modules`, `server.mjs` and `package.json` - **never `src/`**, so server-side routes must not read from the filesystem (put runtime assets in `public/`).

## For agents

`AGENTS.md` holds the hard rules (SSR-only, config through `env()`, media through `/cdn/`, don't break the indexing guard, keep the `sl.js` embed, tag editable content) and a definition-of-done checklist. Read it before editing.

## Docs

- Astro: https://docs.astro.build/en/getting-started/
- Astro node adapter (SSR): https://docs.astro.build/en/guides/integrations-guide/node/
- Justmade Studio: https://studio.justmade.be
- Tailwind 4: https://tailwindcss.com/docs
