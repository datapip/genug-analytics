# ---- build ----
# Installs dependencies and compiles all three workspace packages
# (schema-registry, client, server). Nothing from this stage ships in
# the final image — it's discarded once the runtime stage copies out
# what it needs.
FROM node:24-slim AS build
WORKDIR /app

# better-sqlite3 doesn't have a prebuilt binary for every platform, so
# this is the fallback native-compile toolchain (the same thing
# node-gyp needs locally) in case one isn't available here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy just the manifests first, so Docker can cache this install layer
# (slow, since it may compile a native addon) and skip it on rebuilds
# where only source files changed, not dependencies.
COPY package.json package-lock.json ./
COPY packages/schema-registry/package.json packages/schema-registry/
COPY packages/client/package.json packages/client/
COPY server/package.json server/

RUN npm ci

COPY . .
RUN npm run build

# Drop devDependencies (typescript, eslint, ...) from node_modules —
# nothing past this point needs them to run the already-built output.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Which build this is, for the startup log and the MCP handshake. Pass
# the tag being published: docker build --build-arg GENUG_VERSION=v0.1.0
# An unstamped build says "dev", which is what a local one is.
ARG GENUG_VERSION=dev
ENV GENUG_VERSION=${GENUG_VERSION}

COPY --from=build /app /app

# Runs as the unprivileged `node` user (uid/gid 1000) that the official
# Node images already ship, rather than as root — which is what a
# container does by default. Nothing here needs root: the process binds
# port 3000 (not a privileged <1024 port), reads its own code, and
# writes only to the database directory below.
#
# /app stays root-owned deliberately, so the application can't rewrite
# its own code even if something goes wrong inside it; the node user
# only needs to read it.
#
# /data needs to be writable, and not just the database file: SQLite's
# WAL mode creates -wal/-shm files alongside it, and LOCAL_BACKUPS
# writes a backups/ folder there too, so the directory itself must be
# owned by the runtime user.
#
# IMPORTANT for the deployer: this chown applies to the image. A Docker
# *named volume* inherits it when first created, but a *bind mount* of a
# host directory keeps the host's ownership — so a host directory owned
# by root will not be writable here and the server will fail to open its
# database. Fix it on the host with: chown -R 1000:1000 /your/data/dir
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

# /healthz checks the database is actually reachable, not just that the
# process is alive — so a container that started but can't read its
# volume reports unhealthy instead of silently accepting traffic.
# Node's own fetch, so no curl/wget needs to exist in the runtime image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]
