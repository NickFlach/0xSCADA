# 0xSCADA Hello World Kernel Module

A simple kernel module to verify the 0xSCADA kernel development environment is working correctly.

## Overview

This module demonstrates:
- Basic kernel module structure (init/exit functions)
- Kernel logging with `printk`/`pr_info`
- Module parameters
- Module metadata (license, author, version)

## Prerequisites

- Linux kernel headers installed
- Build tools (gcc, make)
- Root access for loading modules

For building against linux-fork:
```bash
cd /path/to/0xSCADA-QE/linux-fork
make defconfig
make modules_prepare
```

## Building

### Against running kernel:
```bash
make
```

### Against linux-fork:
```bash
make KDIR=/path/to/0xSCADA-QE/linux-fork
# or with relative path
make KDIR=../../../..
```

## Loading and Testing

```bash
# Load the module
sudo insmod hello_scada.ko

# View messages
dmesg | tail -20

# Unload the module
sudo rmmod hello_scada

# View final messages
dmesg | tail -10
```

## Module Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| greeting | string | "Hello from 0xSCADA!" | Custom greeting message |

Example:
```bash
sudo insmod hello_scada.ko greeting="Custom message"
```

## Expected Output

On load (visible via `dmesg`):
```
========================================
0xSCADA Hello World Module Loaded
========================================
  Version: 1.0.0
  Build Date: <build date/time>
  Kernel: <kernel version>
  Machine: <architecture>
  Message: Hello from 0xSCADA!
========================================
0xSCADA kernel development environment is ready!
========================================
```

On unload:
```
========================================
0xSCADA Hello World Module Unloading
========================================
  Module was loaded for: X min Y sec
  Cleanup completed successfully.
  Goodbye from 0xSCADA!
========================================
```

## Makefile Targets

| Target | Description |
|--------|-------------|
| all | Build the module (default) |
| clean | Remove build artifacts |
| install | Install to kernel modules directory |
| load | Build and load the module |
| unload | Unload the module |
| reload | Unload then reload the module |
| dmesg | Show recent kernel messages |
| test | Interactive test (load, show messages, wait, unload) |
| info | Show module metadata |

## Troubleshooting

### "Module verification failed"
If your kernel has module signature verification enabled:
```bash
# Disable temporarily (not recommended for production)
sudo modprobe -r hello_scada
sudo modprobe -f hello_scada
```

### "Required key not available"
The kernel may require signed modules. For development, you can:
1. Sign the module
2. Disable secure boot
3. Build with the kernel's signing key

### Build errors
Ensure kernel headers match your running kernel:
```bash
uname -r
ls /lib/modules/$(uname -r)/build
```

## License

GPL-2.0 (required for Linux kernel modules)
