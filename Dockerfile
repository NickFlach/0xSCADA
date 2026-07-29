# 0xSCADA Full-Stack Dockerfile
#
# Not built by ci.yml's `docker` matrix (that builds docker/{server,client,
# gateway,validator}/Dockerfile); this image is referenced by the root
# docker-compose.yml only.
#
# Node 22, raised from 18: Node 18 is EOL, sqlite3@6 — a direct dependency —
# declares `engines.node >= 20.17.0`, and both `npm ci` invocations below hit
# the same EUSAGE lockfile failure on Node 20's npm 10.8.2 that #598/#604
# describe. Guarded by test/ci/workflow-node-version.test.ts.
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && npm ci --only=development

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app
ENV NODE_ENV=production \
    ENABLE_API_KEYS=true

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S scada -u 1001

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/client ./client
COPY --from=builder /app/contracts ./contracts

# Set ownership
RUN chown -R scada:nodejs /app
USER scada

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5000/api/health || exit 1

# Start the application
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server/index.js"]
