# 0xSCADA Client - React app with nginx
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts postcss.config.js ./
COPY client/ ./client/
COPY shared/ ./shared/
RUN npm run build --workspace=client 2>/dev/null || npx vite build

FROM nginx:1.25-alpine AS production
RUN apk add --no-cache curl
COPY --from=build /app/dist/client /usr/share/nginx/html
COPY docker/client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
