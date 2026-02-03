# 0xSCADA Trace Capture Module

**VERITY Phase α.2.1**: Linux Fork Kernel Trace Capture Pipeline

This module captures kernel traces and industrial data as LFS reality artifacts,
enabling time-travel debugging and deterministic replay of industrial system state.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         TRACE CAPTURE PIPELINE                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │   ftrace    │  │    eBPF     │  │   Modbus    │  │   Firmware   │   │
│  │   Dumps     │  │  Captures   │  │   Bursts    │  │   Images     │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘   │
│         │                │                │                 │           │
│         └────────┬───────┴────────┬───────┴─────────┬──────┘           │
│                  │                │                 │                   │
│                  ▼                ▼                 ▼                   │
│         ┌────────────────────────────────────────────────────┐          │
│         │              Trace Collector Daemon                │          │
│         │    (scada-traced: userspace trace aggregator)      │          │
│         └────────────────────────┬───────────────────────────┘          │
│                                  │                                      │
│                                  ▼                                      │
│         ┌────────────────────────────────────────────────────┐          │
│         │              Artifact Packager                     │          │
│         │    - SHA-256 content hash                          │          │
│         │    - Git commit linkage                            │          │
│         │    - Replay metadata injection                     │          │
│         └────────────────────────┬───────────────────────────┘          │
│                                  │                                      │
│                                  ▼                                      │
│         ┌────────────────────────────────────────────────────┐          │
│         │           LFS Artifact Storage Layer               │          │
│         │         (Content-Addressed Immutable Store)        │          │
│         └────────────────────────────────────────────────────┘          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Kernel Module (`scada_trace.ko`)

Low-overhead kernel module providing:
- Tracepoint hooks for industrial I/O
- Ring buffer for trace events
- `/sys/kernel/debug/scada_trace/` interface
- Atomic snapshot capture with commit correlation

### 2. eBPF Programs (`bpf/`)

Lightweight eBPF programs for:
- Function latency tracing (critical paths)
- I/O timing analysis
- Protocol packet capture
- Custom SCADA event tracking

### 3. Userspace Daemon (`scada-traced`)

Service that:
- Polls kernel trace buffers
- Aggregates and compresses captures
- Links captures to git commits
- Stores as content-addressed LFS artifacts

### 4. CLI Tools (`scada-trace`)

Commands:
- `scada-trace capture` - Trigger immediate capture
- `scada-trace replay` - Replay from artifact
- `scada-trace diff` - Compare two captures
- `scada-trace link` - Link capture to commit

## Directory Structure

```
trace-capture/
├── kernel/                 # Kernel module source
│   ├── scada_trace.c      # Main module
│   ├── scada_trace.h      # Internal headers
│   ├── ring_buffer.c      # Trace ring buffer
│   ├── snapshot.c         # Atomic snapshot capture
│   └── Makefile           # Kernel build
├── bpf/                    # eBPF programs
│   ├── latency.bpf.c      # Function latency
│   ├── io_trace.bpf.c     # I/O operations
│   ├── modbus.bpf.c       # Modbus protocol
│   └── Makefile
├── userspace/              # Userspace tools
│   ├── scada-traced.c     # Daemon
│   ├── scada-trace.c      # CLI tool
│   ├── artifact.h         # Artifact creation
│   ├── lfs.h              # LFS interface
│   └── Makefile
├── include/                # Shared headers
│   ├── scada_trace_api.h  # UAPI header
│   └── replay_metadata.h  # Replay format
├── tests/                  # Test suite
│   ├── kunit/             # Kernel unit tests
│   └── integration/       # Integration tests
└── docs/
    ├── TRACE_FORMAT.md    # Binary format spec
    └── REPLAY_GUIDE.md    # Replay instructions
```

## Trace Types

| Type | Source | Artifact Type | Use Case |
|------|--------|---------------|----------|
| ftrace | Kernel tracing | `trace` | Function flow, timing |
| eBPF | BPF programs | `trace` | Custom event capture |
| Modbus | Protocol driver | `sensor` | Register snapshots |
| Firmware | Flash storage | `firmware` | PLC images |

## Replay Metadata

Each capture includes deterministic replay metadata:

```c
struct replay_metadata {
    u64 capture_timestamp_ns;   // Monotonic capture time
    u64 boot_id;                // Boot instance ID
    u32 cpu_id;                 // Capturing CPU
    char git_commit[41];        // HEAD at capture
    u32 sequence_number;        // Global sequence
    u32 checksum;               // Metadata integrity
};
```

## Building

```bash
# Build kernel module
cd kernel && make

# Build eBPF programs (requires libbpf)
cd bpf && make

# Build userspace tools
cd userspace && make
```

## Usage

```bash
# Start daemon
sudo systemctl start scada-traced

# Manual capture
sudo scada-trace capture --type ftrace --duration 1000

# View artifact
scada-trace show <content-hash>

# Replay
scada-trace replay <content-hash> --verify

# Link to commit
scada-trace link <content-hash> --commit HEAD
```

## Integration with VERITY

Captured traces are stored as `RealityArtifact` with:

```typescript
{
  id: "<sha256-of-content>",
  timestamp: "2026-02-02T...",
  origin: {
    system: "linux",
    device: "plc-01",
    fork: "<git-commit>"
  },
  scope: {
    type: "trace",
    siteId: "plant-a",
    tags: ["ftrace", "realtime"]
  },
  dependencies: ["<previous-capture-hash>"],
  content: {
    version: "v1",
    oid: "<lfs-object-id>",
    size: 1048576
  }
}
```

## Related Documents

- [REALITY_ARTIFACT_ARCHITECTURE.md](../../../docs/REALITY_ARTIFACT_ARCHITECTURE.md)
- [TRACE_FORMAT.md](docs/TRACE_FORMAT.md)
- [REPLAY_GUIDE.md](docs/REPLAY_GUIDE.md)
