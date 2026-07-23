# 0xSCADA Server - Multi-stage Node.js build
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server/ ./server/
COPY shared/ ./shared/
RUN npm run build --workspace=server 2>/dev/null || npx tsc --project tsconfig.json

FROM base AS production
ENV NODE_ENV=production \
    ENABLE_API_KEYS=true
USER node
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/shared ./shared
COPY package.json ./

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server/index.js"]
