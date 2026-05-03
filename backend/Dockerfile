# Backend image — NestJS API service.
#
# At runtime the backend talks to Docker (via mounted socket) to spawn the
# per-job sandbox containers. The container only needs Node + git for the
# host-side clone/push; the sandbox itself runs untrusted install/test/AI work.

FROM node:24-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Trust any directory git encounters inside this container.
#
# The per-job workdirs live under /tmp/coverage-improver-jobs and are bind-
# mounted from the host. macOS Docker Desktop's file-sharing layer surfaces
# them with a uid that doesn't match this container's process owner, so
# git's dubious-ownership safeguard fires when SimpleGit / git
# status / etc. touch them. This container IS the trust boundary; tell git
# to trust any path. (The sandbox image has the same line for the same
# reason.)
RUN git config --global --add safe.directory '*'

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/main.js"]
