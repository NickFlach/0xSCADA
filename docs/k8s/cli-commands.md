# CLI Container Commands

## Overview
Container management commands integrated into the 0xSCADA CLI.

## File
- `cli/src/commands/container.ts`

## Commands

### `oxscada container build`
Build container images.
```bash
oxscada container build                    # Build all
oxscada container build -i oxscada-server  # Build specific
oxscada container build -t v1.0.0          # Custom tag
oxscada container build --no-cache         # Without cache
```

### `oxscada container push`
Push images to registry.
```bash
oxscada container push                     # Push all
oxscada container push -i oxscada-server -t v1.0.0
```

### `oxscada container deploy`
Deploy to Kubernetes.
```bash
oxscada container deploy                   # kubectl apply
oxscada container deploy --helm            # Helm install
oxscada container deploy --helm -f prod-values.yaml
```

### `oxscada container status`
Show pod/service status.
```bash
oxscada container status                   # Default namespace
oxscada container status -a                # All namespaces
```

### `oxscada container logs`
View container logs.
```bash
oxscada container logs oxscada-server      # Last 100 lines
oxscada container logs oxscada-server -f   # Follow
oxscada container logs oxscada-server -t 500
```
