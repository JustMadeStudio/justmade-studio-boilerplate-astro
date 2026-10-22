import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// SSR via the standalone node adapter. The prod container runs `node server.mjs`
// (see server.mjs), which wraps the Astro node handler to add long cache headers.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: process.env.PUBLIC_SITE_URL || 'http://localhost:4321',
  // Off by default: the toolbar draws over the page in `astro dev`, also inside
  // the studio's preview iframe, where it sits on top of the inline editor.
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
  },
});
