#!/bin/bash
# 0xSCADA Linux Kernel Build Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL_DIR="$(dirname "$SCRIPT_DIR")/.."
BUILD_DIR="${KERNEL_DIR}/build"

echo "==================================================="
echo "  0xSCADA Linux Kernel Build"
echo "==================================================="
echo ""
echo "Kernel: $(head -5 ${KERNEL_DIR}/Makefile | grep -E 'VERSION|PATCHLEVEL|SUBLEVEL' | tr '\n' '.' | sed 's/[^0-9.]//g' | sed 's/\.$//')"
echo "Build dir: ${BUILD_DIR}"
echo ""

# Parse arguments
CONFIG_TYPE="${1:-defconfig}"
JOBS="${2:-$(nproc)}"

case "$CONFIG_TYPE" in
    defconfig)
        echo "Using default configuration..."
        make -C "$KERNEL_DIR" O="$BUILD_DIR" defconfig
        ;;
    scada)
        echo "Using 0xSCADA optimized configuration..."
        make -C "$KERNEL_DIR" O="$BUILD_DIR" defconfig
        "${KERNEL_DIR}/scripts/kconfig/merge_config.sh" -m -O "$BUILD_DIR" \
            "$BUILD_DIR/.config" \
            "${KERNEL_DIR}/0xscada/config/scada.config"
        make -C "$KERNEL_DIR" O="$BUILD_DIR" olddefconfig
        ;;
    allnoconfig)
        echo "Using minimal configuration..."
        make -C "$KERNEL_DIR" O="$BUILD_DIR" allnoconfig
        ;;
    *)
        echo "Unknown config type: $CONFIG_TYPE"
        echo "Usage: $0 [defconfig|scada|allnoconfig] [jobs]"
        exit 1
        ;;
esac

echo ""
echo "Building kernel with $JOBS parallel jobs..."
make -C "$KERNEL_DIR" O="$BUILD_DIR" -j"$JOBS"

echo ""
echo "==================================================="
echo "  Build complete!"
echo "==================================================="
echo ""
echo "Kernel image: ${BUILD_DIR}/arch/x86/boot/bzImage"
echo ""
