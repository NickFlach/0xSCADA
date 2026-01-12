#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL_DIR="${SCRIPT_DIR}/../linux-fork"

echo "==================================================="
echo "  0xSCADA Linux Fork - Kernel Configuration"
echo "==================================================="
echo ""

if [ ! -d "$KERNEL_DIR" ]; then
    echo "ERROR: Kernel source not found at $KERNEL_DIR"
    exit 1
fi

cd "$KERNEL_DIR"

CONFIG_TYPE="${1:-defconfig}"

case "$CONFIG_TYPE" in
    defconfig)
        echo "Generating default configuration..."
        make defconfig
        ;;
    menuconfig)
        echo "Opening interactive menu configuration..."
        make menuconfig
        ;;
    tinyconfig)
        echo "Generating minimal (tiny) configuration..."
        make tinyconfig
        ;;
    allnoconfig)
        echo "Generating all-no configuration (minimal base)..."
        make allnoconfig
        ;;
    localmodconfig)
        echo "Generating config based on loaded modules..."
        make localmodconfig
        ;;
    oldconfig)
        echo "Updating existing configuration..."
        make oldconfig
        ;;
    xconfig)
        echo "Opening Qt-based configuration (requires Qt)..."
        make xconfig
        ;;
    *)
        echo "Unknown configuration type: $CONFIG_TYPE"
        echo ""
        echo "Available options:"
        echo "  defconfig      - Default configuration for the architecture"
        echo "  menuconfig     - Interactive terminal menu"
        echo "  tinyconfig     - Minimal kernel configuration"
        echo "  allnoconfig    - All options disabled (base for custom)"
        echo "  localmodconfig - Based on currently loaded modules"
        echo "  oldconfig      - Update existing .config"
        echo "  xconfig        - Qt-based graphical menu"
        exit 1
        ;;
esac

if [ $? -eq 0 ]; then
    echo ""
    echo "==================================================="
    echo "  Configuration completed!"
    echo "==================================================="
    echo ""
    echo "Config file: $KERNEL_DIR/.config"
    echo ""
    echo "Next step: ./build.sh"
else
    echo "ERROR: Configuration failed"
    exit 1
fi
