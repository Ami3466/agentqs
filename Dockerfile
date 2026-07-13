# Debian (glibc), NOT alpine (musl): onnxruntime-node — the local embedder behind
# `recall` and semantic search — ships a glibc-only .so and dies on alpine with
# "Error loading shared library ld-linux-x86-64.so.2", killing search on every
# hosted instance. better-sqlite3 also has a glibc prebuilt, so nothing compiles.

# ---- deps: install node_modules from lockfile ----
FROM node:20-slim AS deps
WORKDIR /app
# python3/make/g++: a fallback for any native dep with no prebuilt for this platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder: compile the Next.js standalone output ----
FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: minimal image that serves the app ----
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV AGENTQS_DATA_DIR=/data
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# git + tar are FEATURES here, not conveniences: `backup github` pushes a snapshot
# branch with git plumbing, and `backup drive` streams the store through tar.
# ca-certificates: every source syncs over TLS.
RUN apt-get update && apt-get install -y --no-install-recommends git tar ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g 1001 nodejs \
  && useradd -u 1001 -g nodejs -m -s /bin/bash nextjs \
  && mkdir -p /data \
  && chown nextjs:nodejs /data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
VOLUME /data
CMD ["node", "server.js"]
