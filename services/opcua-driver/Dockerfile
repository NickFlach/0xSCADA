# 0xSCADA OPC-UA Protocol Driver
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ linux-headers
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY services/opcua-driver/ ./services/opcua-driver/
COPY shared/ ./shared/
RUN npx tsc --project tsconfig.json || true

FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production
USER node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 4840

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4840/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/services/opcua-driver/index.js"]
