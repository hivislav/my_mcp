# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile only, so this layer is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that will be copied forward.
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000 \
    MCP_PATH=/mcp \
    LOG_LEVEL=info

# Run unprivileged. The node image already ships a `node` user, so reuse it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Directory for the periodic collector's JSON history. Created here so it exists
# with the right ownership; at runtime it is replaced by a mounted volume, which
# is required because the root filesystem is read-only.
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000

# The health endpoint is deliberately unauthenticated so orchestrators can probe it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: node receives SIGTERM directly and can shut down gracefully.
CMD ["node", "dist/index.js", "--transport", "http"]
