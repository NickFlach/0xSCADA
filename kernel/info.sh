#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL_DIR="${SCRIPT_DIR}/../linux-fork"

echo "==================================================="
echo "  0xSCADA Linux Fork - Kernel Information"
echo "==================================================="
echo ""

if [ ! -d "$KERNEL_DIR" ]; then
    echo "ERROR: Kernel source not found at $KERNEL_DIR"
    exit 1
fi

cd "$KERNEL_DIR"

VERSION=$(make kernelversion 2>/dev/null)
echo "Kernel Version: $VERSION"
echo ""

echo "Source Directory: $KERNEL_DIR"
echo "Source Size: $(du -sh . 2>/dev/null | cut -f1)"
echo ""

echo "Major Subsystems:"
echo "  arch/     - Architecture-specific code (x86, ARM, RISC-V, etc.)"
echo "  drivers/  - Device drivers"
echo "  fs/       - Filesystem implementations"
echo "  kernel/   - Core kernel code"
echo "  mm/       - Memory management"
echo "  net/      - Networking stack"
echo "  security/ - Security modules (SELinux, AppArmor, etc.)"
echo "  crypto/   - Cryptographic API"
echo "  sound/    - Sound subsystem (ALSA)"
echo "  block/    - Block layer"
echo ""

if [ -f ".config" ]; then
    echo "Configuration: Found"
    echo "  Options enabled:  $(grep -c '=y' .config)"
    echo "  Modules enabled:  $(grep -c '=m' .config)"
else
    echo "Configuration: Not found (run ./configure.sh first)"
fi
echo ""

echo "Supported Architectures:"
ls -1 arch/ | head -10
echo "  ... and more"
echo ""

echo "==================================================="
echo "  Quick Start Commands"
echo "==================================================="
echo ""
echo "  ./configure.sh           # Generate default config"
echo "  ./configure.sh menuconfig # Interactive configuration"
echo "  ./build.sh               # Build the kernel"
echo "  ./build.sh bzImage       # Build just the kernel image"
echo "  ./build.sh modules       # Build kernel modules"
echo "  ./build.sh clean         # Clean build artifacts"
