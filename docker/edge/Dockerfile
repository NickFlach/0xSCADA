# =============================================================================
# 0xSCADA Edge Dockerfile
# Issues #26, #30 — Docker container deployment for edge environments
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (node-opcua, etc.)
RUN apk add --no-cache python3 make g++

# Install dependencies first (Docker layer caching)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

# Copy source and build
COPY tsconfig.json vite.config.ts drizzle.config.ts ./
COPY server/ ./server/
COPY client/ ./client/
COPY shared/ ./shared/

RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ---------------------------------------------------------------------------
# Stage 2: Production
# ---------------------------------------------------------------------------
FROM node:20-alpine

# Security: run as non-root
RUN addgroup -S scada && adduser -S scada -G scada

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Resource hint labels
LABEL org.opencontainers.image.title="0xSCADA Edge"
LABEL org.opencontainers.image.description="Industrial SCADA edge runtime"
LABEL org.opencontainers.image.source="https://github.com/NickFlach/0xSCADA"
LABEL com.0xscada.component="edge"
LABEL com.0xscada.min-memory="128Mi"
LABEL com.0xscada.min-cpu="250m"

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health || exit 1

# Default environment
ENV NODE_ENV=production \
    PORT=5000 \
    LOG_LEVEL=warn \
    GATEWAY_MODE=edge

EXPOSE 5000

USER scada

CMD ["node", "dist/index.js"]
