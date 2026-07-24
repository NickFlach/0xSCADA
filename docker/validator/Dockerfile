# 0xSCADA Blockchain Validator
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init python3 make g++

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY docker/validator/hardhat.config.ts ./docker/validator/hardhat.config.ts
COPY contracts/ ./contracts/
RUN npm run build:validator

FROM node:22-alpine AS production
WORKDIR /app
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/validator/hardhat.config.mjs ./dist/validator/hardhat.config.mjs
COPY --from=build --chown=node:node /app/contracts ./contracts
COPY docker/validator/package.json ./package.json
USER node

EXPOSE 8545 30303

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})}).then(async r=>{const body=await r.json();process.exit(r.ok&&typeof body.result==='string'?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "--no-install", "hardhat", "node", "--config", "dist/validator/hardhat.config.mjs", "--hostname", "0.0.0.0"]
