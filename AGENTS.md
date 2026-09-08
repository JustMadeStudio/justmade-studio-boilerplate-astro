# Agent guide

Rules and context for AI agents working in this repo. Read this before editing.
(Cross-tool convention: Claude Code, Cursor, Copilot, etc. `CLAUDE.md` points here.)

## What this is

A brandless starter for a website on **Astro SSR** with **Justmade Studio** as a
headless CMS. Everything is env-driven: no client name, domain or key is
hardcoded. When you build a real site on top of this, keep it that way.

## Stack (do not swap without being asked)

- Astro, `output: 'server'`, `@astrojs/node` standalone adapter
- Tailwind 4 via `@tailwindcss/vite` (no `tailwind.config.js` - tokens live in `src/styles/app.css` under `@theme`)
- `@justmade/client` for all CMS reads
- `sharp` for server-side image resize + AVIF/WebP encoding
- TypeScript strict, path alias `@/*` -> `src/*`

Docs to consult before touching framework behaviour:
- Astro: https://docs.astro.build/en/getting-started/
- Astro on-demand rendering (SSR): https://docs.astro.build/en/guides/on-demand-rendering/
- Astro node adapter: https://docs.astro.build/en/guides/integrations-guide/node/
- Astro endpoints (the `.ts` routes): https://docs.astro.build/en/guides/endpoints/
- Astro middleware: https://docs.astro.build/en/guides/middleware/

## Hard rules

1. **SSR only, never static.** The site runs as a node server (`npm run start`
   -> `server.mjs`). Do not switch to `output: 'static'` or add `prerender = true`
   to routes that read request data (host, headers, cookies).

2. **Server-side routes must NEVER read from `src/`.** The runtime container
   copies only `dist/`, `node_modules`, `server.mjs`, `package.json` - **not**
   `src/`. Reading a file from `src/` via `import.meta.url` + `node:fs` works
   locally and 500s in production. Runtime assets (fonts for OG images, etc.)
   belong in `public/` (they land in `dist/client`); load them over HTTP
   (`fetch(`${url.origin}/...`)`), not from the filesystem.

3. **All CMS media goes through `/cdn/<key>`.** Never emit a raw
   CDN / `studio.justmade.be` URL into the markup - it leaks the
   backend and skips resizing/caching. Use `cdn()` / `cdnSrcSet()` from
   `src/lib/cdn.ts` (re-exported from `@/lib/studio`), or the `<CdnImage>` /
   `<CdnSource>` components. If you add a new media source, extend
   `resolveTarget()` in `src/pages/cdn/[...key].ts` AND `toKey()` in
   `src/lib/cdn.ts` together - their key shapes must stay in sync.

4. **Never hardcode or commit secrets.** `JUSTMADE_API_KEY` and friends come
   from env only. `.env` is gitignored; only `.env.example` is committed. When a
   new secret is needed, add it to `.env.example` (empty), document it in the
   README table, and register it in `src/lib/env.ts` if it is required at boot.

5. **Don't break the indexing guard.** Only the canonical `PUBLIC_SITE_URL` host
   may be indexed; every preview/staging host must stay `noindex`. The logic
   lives in `src/lib/host.ts` and is applied in three places
   (`middleware.ts` header, `robots.txt.ts` crawl policy, `Base.astro` meta tag).
   Change all three together, and keep using `isProdRequest()` - never compare
   `Astro.url.host` directly (the node adapter reports it as `localhost`; the
   real host is in `x-forwarded-host`).

6. **Keep the `sl.js` embed.** `Base.astro` injects the Justmade Studio inline-editor
   script, but only inside the preview iframe (`window.self !== window.top`).
   This powers Surfaces / inline editing. Don't remove it or load it eagerly.

## Where things live

```
src/lib/studio.ts          CMS client + safe() fallback + boot env check
src/lib/cdn.ts             cloak helpers: cdn(), cdnSrcSet(), isProxyable()
src/lib/host.ts            request-host resolver + prod check (indexing guard)
src/lib/env.ts             boot-time env validation (throws in prod when missing)
src/pages/cdn/[...key].ts   media proxy (cloaking + resize + AVIF/WebP + cache)
src/pages/robots.txt.ts     dynamic robots.txt (prod-only crawl)
src/pages/sitemap.xml.ts    dynamic sitemap (prod-only, wire up your routes)
src/pages/health.ts         liveness probe (/health, no CMS)
src/pages/404.astro         not-found page
src/components/CdnImage.astro   responsive cloaked <img>
src/components/CdnSource.astro  <source> for a cloaked <picture>
src/layouts/Base.astro      head, OG tags, sl.js embed, noindex meta
src/middleware.ts           security headers + CSP frame-ancestors + X-Robots-Tag
src/styles/app.css          Tailwind 4 + @theme design tokens
server.mjs                  prod server (immutable cache on static assets)
Dockerfile                  multi-stage build + healthcheck
```

## Images (cheat sheet)

- Primitive: `cdn(url)`, `cdn(url, 640)`, `cdn(url, { w: 1280, f: 'avif' })` - use
  anywhere (img src, background-image, og:image, preload).
- `<CdnImage src alt width sizes priority />` - responsive `<img>` with srcset.
  Set `priority` on the LCP/above-the-fold image.
- `<CdnSource src format widths sizes />` - one `<source>` inside a `<picture>`;
  put `format="avif"` before `format="webp"`, with `<CdnImage>` as the fallback.
- Format is negotiated per request (AVIF > WebP from `Accept`) unless you pin
  `?f=` / the `format` prop. The route sends `Vary: Accept`.

## Reads that can fail

Wrap every CMS read in `safe()` from `@/lib/studio` so a Justmade Studio hiccup
degrades to a fallback instead of a 500:

```ts
const posts = await safe(() => studio.dataset('blog', 'posts').list(), []);
const page  = await safe(() => studio.dataset('site', 'pages').get(uid), null);
```

## Commands

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # ends with the SEO gate; a hard fault fails the build
npm run seo:gate # run the SEO gate against the current build
npm run start    # prod server (node server.mjs)
```

## Definition of done (before you say it's finished)

- [ ] `npm run build` passes, SEO gate included (see the SEO gate section in README.md)
- [ ] No new `[seo-gate] WARN` you introduced and left behind
- [ ] No raw Justmade Studio / CDN host in the rendered HTML (`curl … | grep -E 'justmade|cdn\.'` = 0)
- [ ] New media renders through `/cdn/…`
- [ ] No secret value committed; new env vars added to `.env.example` + README
- [ ] Preview host still `noindex`, production host still indexable
