# Core Container Images

## Overview
Multi-stage Docker builds for all 0xSCADA components, optimized for size and security.

## Images
| Image | Dockerfile | Base | Port |
|-------|-----------|------|------|
| `oxscada-server` | `docker/server/Dockerfile` | node:22-alpine | 5000 |
| `oxscada-client` | `docker/client/Dockerfile` | nginx:1.25-alpine (build stage: node:22-alpine) | 80 |
| `oxscada-gateway` | `docker/gateway/Dockerfile` | node:22-alpine | 8080 |
| `oxscada-validator` | `docker/validator/Dockerfile` | node:22-alpine | 8545 |
| `oxscada-modbus-driver` | `services/modbus-driver/Dockerfile` | not implemented[^drivers] | 5020 |
| `oxscada-opcua-driver` | `services/opcua-driver/Dockerfile` | not implemented[^drivers] | 4840 |

[^drivers]: `oxscada container build` maps these two image names to
    `services/modbus-driver/Dockerfile` and `services/opcua-driver/Dockerfile`,
    but neither file exists in the repository yet, so the builds fail.

Every Node base is pinned to the 22 line. Node 20 bundles npm 10.8.2, which
rejects the lockfile format current npm (and Dependabot) emits with an EUSAGE
error at `npm ci` — the same failure #598 fixed for the workflow `setup-node`
pins. `test/ci/workflow-node-version.test.ts` asserts both surfaces.

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
