# Chat server. Multi-stage build on Node 22 slim.
# The runtime image has the compiled server and production dependencies.
# Configuration and secrets come from the environment, never from this image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true

RUN npm install -g pnpm@12.9.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/agent/package.json packages/agent/package.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY packages/config packages/config
COPY packages/core packages/core
COPY packages/adapters packages/adapters
COPY packages/agent packages/agent

RUN pnpm exec tsc -b apps/server/tsconfig.json --pretty false
RUN pnpm deploy --filter @devlog/server --prod /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
