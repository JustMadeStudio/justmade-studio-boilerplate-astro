// Custom prod server: wraps the Astro node handler and forces long cache headers
// on fingerprinted static assets. The standalone node adapter serves /_astro/*
// without immutable caching; this script fills that gap.
//
// Container start: `node server.mjs` (see package.json "start" + Dockerfile).
import http from 'node:http';

// ── Boot-time env guard ──────────────────────────────────────────────────────
// Fail loud and early: a prod deploy missing a required var must die before it
// binds the port, not serve half a site on the first CMS request. Kept in sync
// with src/lib/env.ts (which does the same for `astro dev`).
const REQUIRED = ['STUDIOLAYER_API_KEY', 'STUDIOLAYER_PROJECT'];
const missing = REQUIRED.filter((k) => !(process.env[k] || '').trim());
if (missing.length && process.env.NODE_ENV === 'production') {
  console.error(`[env] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[env] Refusing to start in production. Set them and redeploy.');
  process.exit(1);
}
if (missing.length) {
  console.warn(`[env] Missing ${missing.join(', ')} - CMS calls will fail until set.`);
}

// The node adapter is configured in `standalone` mode, so importing the entry
// starts its OWN http server on PORT unless it is told not to. This file exists
// precisely to wrap that handler in a server of its own, so the two would race
// for the same port and the container would die on boot with EADDRINUSE. Must
// be set BEFORE the import: the entry checks it at module evaluation time.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';

const { handler: astroHandler } = await import('./dist/server/entry.mjs');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';

const IMMUTABLE = 'public, max-age=31536000, immutable';

const server = http.createServer((req, res) => {
  // Fingerprinted Astro assets + fonts get immutable caching.
  const url = req.url || '';
  if (url.startsWith('/_astro/') || /\.(woff2?|ttf|otf)(\?|$)/.test(url)) {
    res.setHeader('Cache-Control', IMMUTABLE);
  }
  astroHandler(req, res, (err) => {
    if (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});
