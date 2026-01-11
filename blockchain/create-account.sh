#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GETH_BIN="${SCRIPT_DIR}/../geth-fork/build/bin/geth"
DATA_DIR="${SCRIPT_DIR}/data"

echo "==================================================="
echo "  0xSCADA Blockchain - Create Account"
echo "==================================================="
echo ""

if [ ! -f "$GETH_BIN" ]; then
    echo "ERROR: Geth binary not found at $GETH_BIN"
    echo "Please build geth first"
    exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: Data directory not found. Please run init-chain.sh first."
    exit 1
fi

echo "Creating new account..."
echo ""
echo "You will be prompted to enter a password."
echo "Remember this password - you'll need it to unlock the account!"
echo ""

$GETH_BIN account new --datadir "$DATA_DIR"

echo ""
echo "Account created successfully!"
echo ""
echo "To use this account as a signer, update the genesis.json extradata field"
echo "and re-initialize the chain."
