# 0xSCADA Linux Kernel Module

## Overview

The 0xSCADA kernel module provides infrastructure for capturing industrial reality as cryptographic artifacts. It integrates with the Linux kernel's tracing, networking, and eBPF subsystems to observe and record SCADA/ICS system behavior.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User Space                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Agent (QE)  │  │  Verifier   │  │  Artifact Store     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
└─────────┼────────────────┼─────────────────────┼─────────────┘
          │                │                     │
    ┌─────▼────────────────▼─────────────────────▼─────┐
    │                  /dev/0xscada                     │
    │              (Artifact Interface)                 │
    └─────────────────────┬────────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────────────────┐
│                    Kernel Space                              │
│  ┌──────────────────────▼───────────────────────────────┐   │
│  │                0xSCADA Core                           │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐ │   │
│  │  │  Artifact   │ │   Hash      │ │   Ring Buffer   │ │   │
│  │  │  Factory    │ │   Engine    │ │   (per-CPU)     │ │   │
│  │  └──────┬──────┘ └──────┬──────┘ └────────┬────────┘ │   │
│  └─────────┼───────────────┼─────────────────┼──────────┘   │
│            │               │                 │               │
│  ┌─────────▼───────────────▼─────────────────▼──────────┐   │
│  │              Capture Subsystems                       │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────────────┐ │   │
│  │  │  Trace    │  │  Network  │  │  eBPF             │ │   │
│  │  │  (ftrace) │  │  Filter   │  │  Integration      │ │   │
│  │  └─────┬─────┘  └─────┬─────┘  └─────────┬─────────┘ │   │
│  └────────┼──────────────┼──────────────────┼───────────┘   │
│           │              │                  │                │
│  ┌────────▼──────────────▼──────────────────▼───────────┐   │
│  │              Kernel Subsystems                        │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────────────┐ │   │
│  │  │  ftrace   │  │ netfilter │  │  BPF              │ │   │
│  │  └───────────┘  └───────────┘  └───────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Components

### Core (`core/`)
- **artifact.c**: Artifact creation, hashing, and lifecycle management
- **artifact.h**: Public API for artifact operations

### Trace (`trace/`)
- **scada_trace.c**: ftrace hooks for SCADA-specific events
  - System call interception for I/O operations
  - Timer and scheduling events
  - Hardware interrupt capture

### Network (`net/`)
- **scada_filter.c**: Industrial protocol filtering
  - Modbus TCP (port 502)
  - DNP3 (port 20000)
  - IEC 61850 MMS (port 102)
  - OPC UA (port 4840)

## Building

### As a Module
```bash
make -C /lib/modules/$(uname -r)/build M=$(pwd) modules
```

### In-Tree
Add to your kernel config:
```
CONFIG_SCADA_0X=m
CONFIG_SCADA_0X_CORE=y
CONFIG_SCADA_0X_TRACE=y
CONFIG_SCADA_0X_NET=y
```

## Usage

### Loading the Module
```bash
modprobe 0xscada
```

### Capturing Artifacts
```c
#include <linux/0xscada/artifact.h>

struct scada_artifact *art;

art = scada_artifact_create(SCADA_ORIGIN_SYSTEM, SCADA_SCOPE_LINUX);
if (!art)
    return -ENOMEM;

scada_artifact_set_content(art, data, len);
scada_artifact_set_summary(art, "Modbus read holding registers");
scada_artifact_finalize(art);  /* Computes hash, makes immutable */

/* Artifact is now available via /dev/0xscada */
```

### Reading Artifacts from User Space
```c
int fd = open("/dev/0xscada", O_RDONLY);
struct scada_artifact_header hdr;

while (read(fd, &hdr, sizeof(hdr)) == sizeof(hdr)) {
    /* Process artifact */
    char *content = malloc(hdr.content_size);
    read(fd, content, hdr.content_size);
    /* ... */
}
```

## Configuration

### Sysfs Interface
```
/sys/kernel/0xscada/
├── enabled           # Enable/disable capture (0/1)
├── buffer_size_kb    # Per-CPU ring buffer size
├── hash_algorithm    # sha256 (default), sha512
├── stats/
│   ├── artifacts_created
│   ├── artifacts_dropped
│   ├── bytes_captured
│   └── hash_time_ns
└── filters/
    ├── protocols     # Comma-separated protocol list
    ├── ports         # Port whitelist
    └── syscalls      # Syscall filter mask
```

## Security Considerations

- Artifacts may contain sensitive industrial data
- Use appropriate access controls on /dev/0xscada
- Consider encryption for artifact storage
- Signing requires additional key management

## License

SPDX-License-Identifier: GPL-2.0-only

## See Also

- [ARTIFACT_SPEC.md](../../docs/ARTIFACT_SPEC.md) - Artifact format specification
- [REALITY_DOCTRINE.md](../../REALITY_DOCTRINE.md) - Operating principles
