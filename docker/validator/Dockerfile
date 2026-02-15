# 0xSCADA Blockchain Validator
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init python3 make g++

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json hardhat.config.ts ./
COPY blockchain/ ./blockchain/
COPY contracts/ ./contracts/
COPY shared/ ./shared/
RUN npx tsc --project tsconfig.json || true

FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production
USER node
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts ./contracts
COPY package.json ./

EXPOSE 8545 30303

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8545/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/blockchain/validator.js"]
