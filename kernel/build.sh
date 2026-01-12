#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL_DIR="${SCRIPT_DIR}/../linux-fork"

echo "==================================================="
echo "  0xSCADA Linux Fork - Kernel Build"
echo "==================================================="
echo ""

if [ ! -d "$KERNEL_DIR" ]; then
    echo "ERROR: Kernel source not found at $KERNEL_DIR"
    exit 1
fi

cd "$KERNEL_DIR"

if [ ! -f ".config" ]; then
    echo "ERROR: No kernel configuration found."
    echo "Please run ./configure.sh first."
    exit 1
fi

JOBS="${JOBS:-$(nproc)}"
echo "Building with $JOBS parallel jobs..."
echo ""

BUILD_TARGET="${1:-}"

case "$BUILD_TARGET" in
    "")
        echo "Building full kernel..."
        make -j"$JOBS"
        ;;
    bzImage)
        echo "Building compressed kernel image..."
        make -j"$JOBS" bzImage
        ;;
    modules)
        echo "Building kernel modules..."
        make -j"$JOBS" modules
        ;;
    clean)
        echo "Cleaning build artifacts..."
        make clean
        ;;
    mrproper)
        echo "Deep cleaning (removes .config too)..."
        make mrproper
        ;;
    headers_install)
        echo "Installing kernel headers..."
        make headers_install INSTALL_HDR_PATH="${SCRIPT_DIR}/headers"
        ;;
    *)
        echo "Building target: $BUILD_TARGET"
        make -j"$JOBS" "$BUILD_TARGET"
        ;;
esac

if [ $? -eq 0 ]; then
    echo ""
    echo "==================================================="
    echo "  Build completed!"
    echo "==================================================="
    echo ""
    if [ -f "arch/x86/boot/bzImage" ]; then
        echo "Kernel image: arch/x86/boot/bzImage"
        ls -lh arch/x86/boot/bzImage
    fi
else
    echo "ERROR: Build failed"
    exit 1
fi
