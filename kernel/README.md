# 0xSCADA Linux Kernel Fork

Custom Linux kernel fork for the 0xSCADA industrial control platform.

## Overview

This is a fork of the mainline Linux kernel from Linus Torvalds' repository. It provides a foundation for building custom kernels tailored to industrial SCADA and IoT applications.

## Prerequisites

Required build tools (installed via Nix in this project):

| Package | Purpose |
|---------|---------|
| gcc | C compiler |
| gnumake | Build system |
| flex | Lexical analyzer |
| bison | Parser generator |
| bc | Arbitrary precision calculator |
| perl | Scripting language |
| openssl | Cryptographic library |
| ncurses | Terminal UI (for menuconfig) |
| elfutils | ELF utilities |
| libelf | ELF library |

For cross-compilation, you'll also need the appropriate cross-compiler toolchain (e.g., `aarch64-linux-gnu-gcc` for ARM64).

## Quick Start

```bash
cd kernel

# View kernel information
./info.sh

# Configure the kernel
./configure.sh defconfig

# Build the kernel
./build.sh
```

## Configuration Options

| Command | Description |
|---------|-------------|
| `./configure.sh defconfig` | Default configuration for x86_64 |
| `./configure.sh menuconfig` | Interactive terminal menu |
| `./configure.sh tinyconfig` | Minimal kernel (fast builds) |
| `./configure.sh allnoconfig` | All options off (custom base) |

## Build Commands

| Command | Description |
|---------|-------------|
| `./build.sh` | Full kernel build |
| `./build.sh bzImage` | Compressed kernel image only |
| `./build.sh modules` | Build modules only |
| `./build.sh clean` | Clean build artifacts |
| `./build.sh mrproper` | Deep clean (removes .config) |

## Kernel Structure

```
linux-fork/
├── arch/           # Architecture-specific code
│   ├── x86/        # Intel/AMD
│   ├── arm64/      # ARM 64-bit
│   ├── riscv/      # RISC-V
│   └── ...
├── drivers/        # Device drivers
│   ├── net/        # Network drivers
│   ├── gpio/       # GPIO subsystem
│   ├── iio/        # Industrial I/O
│   ├── spi/        # SPI bus
│   ├── i2c/        # I2C bus
│   └── ...
├── fs/             # Filesystems
├── kernel/         # Core kernel
├── mm/             # Memory management
├── net/            # Networking
├── security/       # Security modules
├── crypto/         # Cryptography
└── Documentation/  # Kernel docs
```

## Industrial I/O (IIO) Subsystem

Particularly relevant for SCADA applications:

- **Location**: `drivers/iio/`
- **ADC drivers**: Analog-to-digital converters
- **DAC drivers**: Digital-to-analog converters
- **Sensor drivers**: Temperature, pressure, humidity
- **GPIO**: General purpose I/O

## Real-Time Capabilities

For industrial control applications, consider:

### PREEMPT_RT Patch
For hard real-time requirements:
```bash
# After applying PREEMPT_RT patch
./configure.sh menuconfig
# Enable: General setup -> Preemption Model -> Fully Preemptible Kernel
```

### Kernel Config Options
```
CONFIG_PREEMPT=y           # Enable preemption
CONFIG_HZ_1000=y           # 1000Hz timer
CONFIG_NO_HZ_FULL=y        # Tickless for dedicated CPUs
CONFIG_HIGH_RES_TIMERS=y   # High resolution timers
```

## Customization for SCADA

### Minimal Industrial Kernel

Start with `tinyconfig` and add only what you need:

```bash
./configure.sh tinyconfig
./configure.sh menuconfig

# Add these essentials:
# - Networking support
# - GPIO support
# - SPI/I2C support
# - IIO subsystem
# - Your specific drivers
```

### Security Hardening

For production SCADA systems:

```
CONFIG_SECURITY=y
CONFIG_SECURITY_SELINUX=y
CONFIG_STRICT_KERNEL_RWX=y
CONFIG_STACKPROTECTOR_STRONG=y
CONFIG_FORTIFY_SOURCE=y
```

## Cross-Compilation

For embedded targets:

```bash
# ARM64
export ARCH=arm64
export CROSS_COMPILE=aarch64-linux-gnu-
./configure.sh defconfig
./build.sh

# RISC-V
export ARCH=riscv
export CROSS_COMPILE=riscv64-linux-gnu-
./configure.sh defconfig
./build.sh
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| JOBS | $(nproc) | Parallel build jobs |
| ARCH | (native) | Target architecture |
| CROSS_COMPILE | (none) | Cross-compiler prefix |

## Files

- `configure.sh` - Kernel configuration helper
- `build.sh` - Kernel build helper
- `info.sh` - Display kernel information
- `../linux-fork/` - Kernel source code

## Resources

- [Kernel Documentation](https://www.kernel.org/doc/html/latest/)
- [Industrial I/O](https://www.kernel.org/doc/html/latest/driver-api/iio/)
- [Real-Time Linux](https://wiki.linuxfoundation.org/realtime/start)
- [Kernel Newbies](https://kernelnewbies.org/)

## Contributing

1. Create a feature branch in `linux-fork/`
2. Make your changes
3. Test with `./build.sh`
4. Document changes

## License

The Linux kernel is licensed under GPL-2.0.
