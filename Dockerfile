# ---- build ----
# Installs dependencies and compiles the three workspace packages
# (schema-registry, client, server). This stage is not part of the final
# image; the runtime stage copies out what it needs.
FROM node:24-slim AS build
WORKDIR /app

# Build tools for compiling better-sqlite3, in case no prebuilt binary
# exists for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy only the package files first, so Docker can cache the slow install
# step and skip it when only source files changed.
COPY package.json package-lock.json ./
COPY packages/schema-registry/package.json packages/schema-registry/
COPY packages/client/package.json packages/client/
COPY server/package.json server/

RUN npm ci

COPY . .
RUN npm run build

# The IP-to-country table that COUNTRY_LOOKUP=true uses. Always
# downloaded, so one image works with the lookup on or off. A failed
# download fails the build.
RUN node scripts/fetch-country-data.mjs
# Load it once here, so a table in an unexpected format fails the build
# instead of the first deployment that turns the lookup on.
RUN node -e "import('./server/dist/lib/country.js').then((m) => m.loadCountryTable('server/country-data'))"

# Remove devDependencies (typescript, eslint, ...); the built code
# doesn't need them.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The version, shown in the startup log and the MCP handshake. Pass the
# release tag: docker build --build-arg GENUG_VERSION=v0.1.0
# Without it the version is "dev".
ARG GENUG_VERSION=dev
ENV GENUG_VERSION=${GENUG_VERSION}

COPY --from=build /app /app

# Runs as the `node` user (uid/gid 1000) from the official Node image,
# not as root. Nothing needs root: the server listens on port 3000 (not
# below 1024), reads its code and only writes to /data.
#
# /app stays owned by root on purpose, so the application can't change
# its own code; the node user only needs to read it.
#
# The /data folder itself must be writable, not just the database file:
# SQLite creates -wal and -shm files next to it, and backups go into a
# backups/ folder there.
#
# IMPORTANT when deploying: this chown only applies inside the image. A
# Docker named volume takes it over when created, but a bind-mounted host
# folder keeps its owner on the host. If that is root, the server can't
# open its database. Fix it on the host with:
# chown -R 1000:1000 /your/data/dir
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

# /healthz checks that the database can be read, not just that the
# process runs, so a container that can't read its volume reports
# unhealthy. Uses Node's fetch, so the image needs no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]
