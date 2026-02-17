# Containerized Edge Runtime Pattern

> Issue #30 — [Edge] Containerized Edge Runtime Pattern

## Overview

This document describes the containerized runtime pattern for deploying 0xSCADA at the industrial edge. The pattern uses Docker to package the application with all dependencies, enabling consistent deployment across heterogeneous edge hardware.

## Components

### Docker Files

| File | Purpose |
|------|---------|
| `docker/edge/Dockerfile` | Multi-stage build for minimal production image |
| `docker/edge/docker-compose.yml` | Complete edge stack (app + database) |

### Image Characteristics

- **Base:** `node:20-alpine` (~130 MB)
- **Final image:** ~200-300 MB (depending on native modules)
- **Non-root execution** — runs as `scada` user
- **Health check** — built-in HTTP health endpoint
- **Labels** — OCI-compliant metadata

## Deployment

### Quick Start

```bash
cd 0xSCADA
docker-compose -f docker/edge/docker-compose.yml up -d
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | HTTP server port |
| `DATABASE_URL` | (compose default) | PostgreSQL connection string |
| `GATEWAY_MODE` | `edge` | Runtime mode (`edge` or `full`) |
| `OPCUA_ENDPOINT` | `opc.tcp://host.docker.internal:4840` | OPC-UA server to connect |
| `LOG_LEVEL` | `warn` | Logging level |
| `CPU_LIMIT` | `1.0` | CPU limit for edge container |
| `MEMORY_LIMIT` | `512M` | Memory limit for edge container |

### Resource Profiles

#### Minimal (Raspberry Pi, ARM SBC)
```env
CPU_LIMIT=0.5
MEMORY_LIMIT=256M
LOG_LEVEL=error
```

#### Standard (Industrial PC, x64)
```env
CPU_LIMIT=2.0
MEMORY_LIMIT=1G
LOG_LEVEL=warn
```

#### Development
```env
CPU_LIMIT=4.0
MEMORY_LIMIT=2G
LOG_LEVEL=debug
```

## Architecture

```
┌──────────────────────────────────────┐
│  Docker Host (Edge Device)           │
│                                      │
│  ┌─────────────────────────────────┐ │
│  │  scada-edge container          │ │
│  │  ┌──────────┐  ┌────────────┐  │ │
│  │  │ Gateway  │  │ API Server │  │ │
│  │  │ Drivers  │  │ :5000      │  │ │
│  │  └──────────┘  └────────────┘  │ │
│  └─────────────────────────────────┘ │
│                                      │
│  ┌─────────────────────────────────┐ │
│  │  scada-edge-db container       │ │
│  │  PostgreSQL 16 Alpine          │ │
│  │  Volume: pgdata                │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

## Operational Patterns

### Automatic Restart
Both containers use `restart: always` — they recover from crashes and start on boot.

### Data Persistence
PostgreSQL data is stored in a named volume (`pgdata`), surviving container restarts and upgrades.

### Upgrading
```bash
# Pull new image
docker-compose -f docker/edge/docker-compose.yml pull

# Restart with zero-downtime for database
docker-compose -f docker/edge/docker-compose.yml up -d --no-deps scada-edge
```

### Monitoring
- Health check endpoint: `GET /api/health`
- Docker health status: `docker inspect --format='{{.State.Health.Status}}' scada-edge`
- Logs: `docker logs -f scada-edge`

### Offline Deployment
```bash
# Build and save on a connected machine
docker-compose -f docker/edge/docker-compose.yml build
docker save 0xscada-edge_scada-edge postgres:16-alpine | gzip > edge-bundle.tar.gz

# Transfer and load on air-gapped device
docker load < edge-bundle.tar.gz
docker-compose -f docker/edge/docker-compose.yml up -d
```

## Security Considerations

- Container runs as non-root user (`scada`)
- Network isolation via Docker bridge network
- No host network mode — explicit port mapping only
- Database credentials should be rotated in production (use Docker secrets or vault)
- Keep base images updated for security patches

## Related

- [Docker Edge Deployment Patterns](../optix/docker-edge-deployment.md)
- [Edge & Gateway Integration](edge-gateway-integration.md)
- [Architecture Onboarding](architecture-onboarding.md)
