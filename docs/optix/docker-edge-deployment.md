# Docker Edge Deployment Patterns

> Issue #26 — [Optix/Edge] Integrate Docker container deployment patterns

## Overview

This document describes Docker container patterns for deploying 0xSCADA components to edge environments — resource-constrained industrial devices running near OT equipment.

## Dockerfile: Multi-Stage Build

See `docker/edge/Dockerfile` for the production-ready image.

### Build Stages

1. **Builder** — Install all dependencies, compile TypeScript, build client assets
2. **Production** — Copy only compiled output and production node_modules (~80% smaller)

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 5000
CMD ["node", "dist/index.js"]
```

## Resource Constraints

Edge devices often have limited CPU, memory, and storage. Use Docker resource flags:

```yaml
deploy:
  resources:
    limits:
      cpus: "1.0"
      memory: 512M
    reservations:
      cpus: "0.25"
      memory: 128M
```

### Recommended Minimums

| Component | CPU | Memory | Storage |
|-----------|-----|--------|---------|
| Gateway only | 0.25 cores | 128 MB | 200 MB |
| Gateway + API | 0.5 cores | 256 MB | 500 MB |
| Full stack | 1.0 cores | 512 MB | 1 GB |

## Health Checks

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health || exit 1
```

## Environment Configuration

Edge containers are configured via environment variables:

```env
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@db:5432/scada
GATEWAY_MODE=edge
OPCUA_ENDPOINT=opc.tcp://plc:4840
LOG_LEVEL=warn
```

## Deployment Strategies

### 1. Single Container (Simplest)
For devices running one 0xSCADA instance:
```bash
docker run -d --restart=always --memory=256m --cpus=0.5 \
  -p 5000:5000 --env-file .env 0xscada/edge:latest
```

### 2. Docker Compose (Recommended)
See `docker/edge/docker-compose.yml` for multi-service deployment with database and monitoring.

### 3. Fleet Management
For managing many edge devices:
- **Azure IoT Edge** — Deploy via IoT Hub module twins
- **Portainer Edge** — Web-based container management
- **Balena** — Purpose-built for IoT fleet management

## Image Optimization

- Use `node:20-alpine` (130 MB vs 1 GB for full Debian)
- Multi-stage builds eliminate dev dependencies
- `.dockerignore` excludes node_modules, .git, docs, tests
- Pin exact versions in package-lock.json for reproducibility

## Offline / Air-Gapped Deployment

Many OT environments have no internet access:

```bash
# On build machine
docker save 0xscada/edge:latest | gzip > 0xscada-edge.tar.gz

# On edge device
docker load < 0xscada-edge.tar.gz
docker-compose up -d
```

## Related

- [Containerized Edge Runtime](../vendor/containerized-edge.md)
- [Edge & Gateway Integration](../vendor/edge-gateway-integration.md)
- [OptixEdge Study](optix-edge-study.md)
