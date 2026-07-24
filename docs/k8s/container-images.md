# Core Container Images

## Overview
Multi-stage Docker builds for all 0xSCADA components, optimized for size and security.

## Images
| Image | Dockerfile | Base | Port |
|-------|-----------|------|------|
| `oxscada-server` | `docker/server/Dockerfile` | node:20-alpine | 5000 |
| `oxscada-client` | `docker/client/Dockerfile` | nginx:1.25-alpine | 80 |
| `oxscada-gateway` | `docker/gateway/Dockerfile` | node:20-alpine | 8080 |
| `oxscada-validator` | `docker/validator/Dockerfile` | node:20-alpine | 8545 |
| `oxscada-modbus-driver` | `services/modbus-driver/Dockerfile` | node:20-alpine | 5020 |
| `oxscada-opcua-driver` | `services/opcua-driver/Dockerfile` | node:20-alpine | 4840 |

## Building
```bash
# Build all images
oxscada container build

# Build specific image
oxscada container build -i oxscada-server -t v1.0.0

# Push to registry
oxscada container push -t v1.0.0
```

## Security Features
- Non-root user execution
- Multi-stage builds (no build tools in production)
- Read-only root filesystem
- Health checks on all images
- `dumb-init` for proper signal handling

The gateway image contains only the bundled `dist/gateway/index.cjs` runtime
artifact. Set its required `SERVER_URL` environment variable to the fixed
0xSCADA server origin; the image does not start or import the server process.
