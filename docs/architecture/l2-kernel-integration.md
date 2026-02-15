# L2 Kernel Integration

> Issue #149 — Integrate existing Ethereum tooling with resonant kernel layer

## Overview

Bridge standard Ethereum L2 tooling (ethers.js, JSON-RPC) with the 0xSCADA kernel event system. Applications can use familiar Ethereum patterns while operations are routed through the kernel for real-time processing and anchoring.

## Architecture

```
┌──────────────────┐        ┌─────────────────────┐       ┌──────────────┐
│  DApp / ethers.js│───RPC──│  KernelL2Provider    │──────│  Kernel Event │
│                  │        │  (custom RPC server)  │      │  Pipeline     │
│  Standard        │        │                       │      └──────┬───────┘
│  eth_* calls     │        │  oxscada_* methods    │             │
└──────────────────┘        └──────────┬────────────┘      ┌──────▼───────┐
                                       │                   │  Batch Anchor │
                                       │ forward           │  (Merkle root)│
                                       ▼                   └──────┬───────┘
                            ┌──────────────────────┐              │
                            │  Upstream L2 RPC     │◄─────────────┘
                            │  (Optimism/Arbitrum) │   submitBatch tx
                            └──────────────────────┘
```

## Custom RPC Methods

| Method | Params | Description |
|--------|--------|-------------|
| `oxscada_submitEvent` | `(type, source, dataHex)` | Inject event into kernel pipeline |
| `oxscada_getBatch` | `(batchId)` | Query anchor batch status |
| `oxscada_getStateRoot` | `()` | Get latest L2 state root |
| `oxscada_verifyProof` | `(root, leaf, proof[])` | Verify Merkle inclusion proof |

Standard `eth_*` methods are forwarded to the upstream L2 RPC.

## Event Flow

1. Kernel event produced (sensor reading, actuator command)
2. `KernelEventAdapter` converts to Ethereum-compatible log format
3. Events buffered until batch size or interval reached
4. Merkle root computed over batch
5. Anchor transaction submitted to L2 EventAnchor contract
6. Confirmation monitored; batch status updated

## Configuration

```typescript
const config: L2Config = {
  rpcUrl: "https://optimism-sepolia.infura.io/v3/...",
  chainId: 11155420,
  kernelEventEndpoint: "ws://localhost:9401",
  batchSize: 256,
  batchIntervalMs: 10000,
  confirmationBlocks: 64,
  contractAddresses: {
    eventAnchor: "0x...",
    stateOracle: "0x...",
    proofVerifier: "0x...",
  },
};
```
