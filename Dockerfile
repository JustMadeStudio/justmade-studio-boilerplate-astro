# syntax=docker/dockerfile:1

# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app

# cap node heap during build so vite/rolldown can't blow past RAM
ENV NODE_OPTIONS=--max-old-space-size=1536

COPY package*.json ./
RUN npm install

# The build ends with the SEO gate (scripts/seo-gate.mjs), which needs to know
# the canonical host: without it every page is served noindex and the gate has
# nothing meaningful to check, so it fails the image build on purpose. Pass it
# from the host (Coolify build arg / `docker build --build-arg`).
ARG PUBLIC_SITE_URL
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL

COPY . .
RUN npm run build

# --- runtime stage ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

# Copy ONLY what the runtime needs. NOT src/ - server-side routes must never
# read from src/ (it does not exist in the container). Runtime assets (fonts
# for OG images, etc.) belong in public/ (they end up in dist/client).
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/package.json ./package.json

EXPOSE 4321

# Liveness probe: hits /health (process-only, never touches the CMS).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "./server.mjs"]
