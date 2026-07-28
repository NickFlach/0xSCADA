# 0xSCADA Client - React app with nginx
# Node 22: its bundled npm 10.9+ reads the lockfile format current npm and
# Dependabot emit. Node 20 ships npm 10.8.2, which fails `npm ci` with EUSAGE
# (#598, #604). Guarded by test/ci/workflow-node-version.test.ts.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY client/ ./client/
COPY shared/ ./shared/
RUN npm run build --workspace=client 2>/dev/null || npx vite build

FROM nginx:1.25-alpine AS production
RUN apk add --no-cache curl
COPY --from=build /app/client/dist /usr/share/nginx/html
COPY docker/client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
