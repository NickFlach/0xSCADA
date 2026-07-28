# 0xSCADA standalone HTTP/WebSocket gateway
# Node 22: its bundled npm 10.9+ reads the lockfile format current npm and
# Dependabot emit. Node 20 ships npm 10.8.2, which fails `npm ci` with EUSAGE
# (#598, #604). Guarded by test/ci/workflow-node-version.test.ts.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY gateway/ ./gateway/
RUN npm run build:gateway

FROM node:22-alpine AS production
WORKDIR /app
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=build --chown=node:node /app/dist/gateway/index.cjs ./dist/gateway/index.cjs

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/gateway/index.cjs"]
