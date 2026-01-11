#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GETH_BIN="${SCRIPT_DIR}/../geth-fork/build/bin/geth"
DATA_DIR="${SCRIPT_DIR}/data"

echo "==================================================="
echo "  0xSCADA Blockchain - Starting Node"
echo "==================================================="
echo ""

if [ ! -f "$GETH_BIN" ]; then
    echo "ERROR: Geth binary not found at $GETH_BIN"
    echo "Please build geth first: cd geth-fork && make geth"
    exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: Data directory not found. Please run init-chain.sh first."
    exit 1
fi

SIGNER_ADDRESS="${SIGNER_ADDRESS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"

if [ -z "$SIGNER_PASSWORD" ]; then
    echo "ERROR: SIGNER_PASSWORD environment variable is required."
    echo ""
    echo "Usage: SIGNER_PASSWORD=your_password ./start-node.sh"
    echo ""
    echo "For development only, you can also use:"
    echo "  export SIGNER_PASSWORD=your_password"
    exit 1
fi

HTTP_ADDR="${HTTP_ADDR:-127.0.0.1}"
WS_ADDR="${WS_ADDR:-127.0.0.1}"

echo "Network ID: 380634"
echo "HTTP RPC: http://${HTTP_ADDR}:8545"
echo "WebSocket: ws://${WS_ADDR}:8546"
echo "Signer Address: $SIGNER_ADDRESS"
echo ""

EXTRA_ARGS=""
if [ "${ALLOW_REMOTE_ACCESS}" = "true" ]; then
    echo "WARNING: Remote access enabled. Ensure proper firewall rules!"
    HTTP_ADDR="0.0.0.0"
    WS_ADDR="0.0.0.0"
    EXTRA_ARGS="--allow-insecure-unlock"
fi

echo "Starting geth node..."
echo ""

$GETH_BIN \
    --datadir "$DATA_DIR" \
    --networkid 380634 \
    --port 30303 \
    --http \
    --http.addr "$HTTP_ADDR" \
    --http.port 8545 \
    --http.api "eth,net,web3,personal,admin,txpool,debug,clique" \
    --http.corsdomain "*" \
    --http.vhosts "*" \
    --ws \
    --ws.addr "$WS_ADDR" \
    --ws.port 8546 \
    --ws.api "eth,net,web3,personal,admin,txpool,debug,clique" \
    --ws.origins "*" \
    $EXTRA_ARGS \
    --unlock "$SIGNER_ADDRESS" \
    --password <(echo "$SIGNER_PASSWORD") \
    --mine \
    --miner.etherbase "$SIGNER_ADDRESS" \
    --verbosity 3 \
    --gcmode archive \
    console
