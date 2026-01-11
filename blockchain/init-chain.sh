#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GETH_BIN="${SCRIPT_DIR}/../geth-fork/build/bin/geth"
DATA_DIR="${SCRIPT_DIR}/data"
GENESIS_FILE="${SCRIPT_DIR}/genesis.json"

echo "==================================================="
echo "  0xSCADA Blockchain - Chain Initialization"
echo "==================================================="
echo ""
echo "Chain ID: 380634 (0x5CADA)"
echo "Consensus: Clique (Proof of Authority)"
echo "Block Time: 5 seconds"
echo "Gas Limit: 30,000,000"
echo ""

if [ ! -f "$GETH_BIN" ]; then
    echo "ERROR: Geth binary not found at $GETH_BIN"
    echo "Please build geth first: cd geth-fork && make geth"
    exit 1
fi

if [ ! -f "$GENESIS_FILE" ]; then
    echo "ERROR: Genesis file not found at $GENESIS_FILE"
    exit 1
fi

if [ -d "$DATA_DIR" ]; then
    echo "WARNING: Data directory already exists. Removing..."
    rm -rf "$DATA_DIR"
fi

echo "Initializing blockchain with genesis block..."
$GETH_BIN init --datadir "$DATA_DIR" "$GENESIS_FILE"

if [ $? -eq 0 ]; then
    echo ""
    echo "==================================================="
    echo "  Blockchain initialized successfully!"
    echo "==================================================="
    echo ""
    echo "Data directory: $DATA_DIR"
    echo ""
    echo "Next steps:"
    echo "  1. Create a signer account: ./create-account.sh"
    echo "  2. Start the node: ./start-node.sh"
    echo ""
else
    echo "ERROR: Failed to initialize blockchain"
    exit 1
fi
