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
# V8 sizes its old-space from the container's RAM and will grow toward roughly half of
# it before collecting hard — on a 4GB container that is the drift to ~2GB of JS heap.
# Cap it so the JS side collects at a sane ceiling instead.
# HONEST SCOPE: this bounds the JS HEAP ONLY. The local models (embedder, captioner,
# Whisper) hold their weights and onnxruntime arenas in NATIVE memory, which this flag
# does not touch and cannot reclaim — that cost is handled by the idle eviction in
# src/lib/model-slot.ts, not here.
ENV NODE_OPTIONS=--max-old-space-size=1536

# git + tar are FEATURES here, not conveniences: `backup github` pushes a snapshot
# branch with git plumbing, and `backup drive` streams the store through tar.
# ca-certificates: every source syncs over TLS.
# curl: node:20-slim installs it to fetch node and PURGES it in the same layer, so the
# image ships none. A hosting platform's HTTP health check (Coolify's default) shells
# INTO the container and runs curl - without it the app deploys fine and is then marked
# unhealthy, which reads as a broken app.
RUN apt-get update && apt-get install -y --no-install-recommends git tar ca-certificates curl \
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
