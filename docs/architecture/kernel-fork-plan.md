# Kernel Fork Plan — 0xSCADA

> Issue #140 — Fork Linux kernel with 0xSCADA customizations

## Overview

0xSCADA requires a custom Linux kernel that provides deterministic, real-time event processing for industrial SCADA systems with blockchain anchoring. This document describes the fork plan.

## Base Kernel

- **Version:** Linux 6.6 LTS (Long Term Support through Dec 2026)
- **Why 6.6:** Stable PREEMPT_RT merge progress, io_uring maturity, eBPF improvements, broad hardware support for industrial SBCs and edge devices.
- **Alternative:** Linux 6.1 LTS if maximum stability is required (supported through Dec 2026).

## PREEMPT_RT Integration

The PREEMPT_RT patchset converts the kernel to a fully preemptible real-time kernel:

1. Apply `patch-6.6-rt*` from kernel.org/pub/linux/kernel/projects/rt/
2. Configure `CONFIG_PREEMPT_RT=y`
3. Set scheduling policy defaults for SCADA event threads to `SCHED_FIFO`
4. Target worst-case latency: **< 50 µs** on x86_64, **< 100 µs** on ARM64

## Custom Modules

### oxscada-event (`drivers/oxscada/event/`)
- Kernel-space event ring buffer with lock-free publish/subscribe
- Netlink interface for userspace event injection
- `/proc/oxscada/events` for monitoring

### oxscada-crypto (`drivers/oxscada/crypto/`)
- Kernel crypto subsystem integration for HSM operations
- PKCS#11 bridge from kernel crypto API
- SHA-256 / Keccak-256 hardware acceleration hooks
- Merkle proof verification in kernel space (O(log n))

### oxscada-bridge (`drivers/oxscada/bridge/`)
- L2 state sync driver
- Memory-mapped state root storage
- DMA-based batch transfer to userspace anchoring service

### oxscada-watchdog (`drivers/oxscada/watchdog/`)
- SCADA-specific watchdog with consensus health checks
- Automatic failover triggers
- Heartbeat integration with decentralized orchestrator

## Kconfig Structure

See `kernel/Kconfig.oxscada` for the full configuration tree. Key options:

| Option | Default | Description |
|--------|---------|-------------|
| `CONFIG_OXSCADA` | m | Master toggle |
| `CONFIG_OXSCADA_EVENT` | m | Event subsystem |
| `CONFIG_OXSCADA_CRYPTO` | m | Crypto/HSM bridge |
| `CONFIG_OXSCADA_BRIDGE` | m | L2 state sync |
| `CONFIG_OXSCADA_RT` | y | Real-time optimizations |

## Build System

### Toolchain
- **Compiler:** GCC 13+ or Clang 17+ with LTO
- **Cross-compile:** `aarch64-linux-gnu-` for ARM64 targets
- **Build wrapper:** `make O=build/ oxscada_defconfig && make O=build/ -j$(nproc)`

### Output Artifacts
- `bzImage` / `Image.gz` — compressed kernel
- `oxscada-modules-*.tar.gz` — module package
- `oxscada-headers-*.deb` — development headers
- Docker base image: `ghcr.io/nickflach/0xscada-kernel:6.6-rt`

## CI/CD Pipeline

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Push/PR     │────▶│  Build Matrix│────▶│  Test Suite   │
│  to kernel/* │     │  x86_64      │     │  - boot test  │
│              │     │  aarch64     │     │  - RT latency │
│              │     │  riscv64     │     │  - module load│
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │  Publish      │
                                          │  - GHCR image │
                                          │  - .deb pkgs  │
                                          │  - Release    │
                                          └──────────────┘
```

### GitHub Actions Workflow
1. **Trigger:** Push to `kernel/*` or tag `kernel-v*`
2. **Build stage:** Matrix build (x86_64, aarch64) in Docker with cached ccache
3. **Test stage:**
   - QEMU boot test with virtme
   - `cyclictest` RT latency validation (must be < 50 µs p99)
   - Module load/unload smoke tests
   - Event subsystem integration tests
4. **Publish stage:** Push Docker image + release artifacts on tag

### Release Cadence
- **Nightly:** automated builds from `kernel/main`
- **Weekly:** integration-tested builds
- **Monthly:** stable releases with full regression testing
- **On-demand:** security patches within 48h of upstream CVE

## Security Considerations

- Kernel lockdown mode enabled by default (`CONFIG_LOCK_DOWN_KERNEL_FORCE_INTEGRITY=y`)
- Module signature verification required (`CONFIG_MODULE_SIG_FORCE=y`)
- All 0xSCADA modules signed with project signing key stored in HSM
- Stack protector + KASLR + KASAN in debug builds
- Seccomp-BPF profiles for userspace SCADA daemons

## Migration Path

1. **Phase 1:** Build custom kernel with PREEMPT_RT, no custom modules → validate RT guarantees
2. **Phase 2:** Add oxscada-event module → validate event throughput
3. **Phase 3:** Add oxscada-crypto → integrate with HSM subsystem
4. **Phase 4:** Add oxscada-bridge → end-to-end L2 state sync
5. **Phase 5:** Production hardening, security audit, performance tuning
