#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GETH_BIN="${SCRIPT_DIR}/../geth-fork/build/bin/geth"
DATA_DIR="${SCRIPT_DIR}/data"

echo "==================================================="
echo "  0xSCADA Blockchain - Import Private Key"
echo "==================================================="
echo ""

if [ ! -f "$GETH_BIN" ]; then
    echo "ERROR: Geth binary not found at $GETH_BIN"
    exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: Data directory not found. Please run init-chain.sh first."
    exit 1
fi

HARDHAT_KEY="ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

echo "Importing Hardhat default account #0 private key..."
echo "(Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)"
echo ""

TEMP_KEY_FILE=$(mktemp)
echo "$HARDHAT_KEY" > "$TEMP_KEY_FILE"

echo "Enter a password to protect this key:"
$GETH_BIN account import --datadir "$DATA_DIR" "$TEMP_KEY_FILE"

rm -f "$TEMP_KEY_FILE"

echo ""
echo "Key imported successfully!"
echo "Use this password when starting the node."
