# 0xSCADA Linux Kernel Fork

Custom Linux kernel fork for industrial SCADA applications.

## Purpose

This kernel fork is optimized for:
- **Industrial control systems** - Deterministic latency, real-time patches
- **Embedded gateways** - Minimal footprint, security hardened
- **Blockchain nodes** - Optimized networking, cryptographic acceleration

## Directory Structure

```
0xscada/
├── config/           # Kernel configurations
│   ├── scada_defconfig    # Default SCADA-optimized config
│   └── scada_debug.config # Debug/development config
├── tests/            # Custom test suites
│   ├── unit/         # KUnit tests
│   ├── integration/  # System integration tests
│   └── performance/  # Benchmark tests
├── scripts/          # Build and test automation
└── docs/             # Technical documentation
```

## Quick Start

### Build Configuration
```bash
# Generate default config
make defconfig
cp 0xscada/config/scada.config .config
make olddefconfig

# Build kernel
make -j$(nproc)
```

### Run Tests
```bash
# KUnit tests
./tools/testing/kunit/kunit.py run

# Selftests
make -C tools/testing/selftests run_tests
```

## Key Customizations

1. **PREEMPT_RT** - Real-time preemption support
2. **Security** - Hardened kernel options enabled
3. **Networking** - Optimized for industrial protocols
4. **Crypto** - Hardware acceleration where available

## Testing Strategy

| Test Type | Framework | Purpose |
|-----------|-----------|---------|
| Unit | KUnit | Kernel subsystem testing |
| Integration | kselftest | System call and driver testing |
| Fuzzing | syzkaller | Security vulnerability discovery |
| Performance | perf/hackbench | Latency and throughput benchmarks |

## Version

- Base: Linux 6.19-rc5
- Fork: 0xSCADA v0.1.0
