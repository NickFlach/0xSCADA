# Hardhat Tasks — Kernel Module Interaction

> Issue #157 — Hardhat tasks for kernel module interaction

## Overview

Custom Hardhat tasks for interacting with the EventAnchor contract and related on-chain components from the command line.

## Tasks

### `deploy-event-anchor`

Deploy the EventAnchor contract.

```bash
npx hardhat deploy-event-anchor --network optimism-sepolia
npx hardhat deploy-event-anchor --owner 0x... --min-batch-size 10 --max-batch-size 1000
```

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `--owner` | No | Deployer | Contract owner address |
| `--min-batch-size` | No | 1 | Minimum events per batch |
| `--max-batch-size` | No | 10000 | Maximum events per batch |

Auto-verifies on block explorer for non-local networks.

### `submit-batch`

Submit an event batch with a Merkle root.

```bash
npx hardhat submit-batch \
  --contract 0x... \
  --root 0xabcd...1234 \
  --count 256 \
  --metadata "batch-2026-02-14" \
  --network optimism-sepolia
```

### `verify-proof`

Verify a Merkle inclusion proof on-chain.

```bash
npx hardhat verify-proof \
  --contract 0x... \
  --root 0xabcd...1234 \
  --leaf 0xdead...beef \
  --proof 0x1111,0x2222,0x3333 \
  --index 42
```

### `query-state`

Query contract state (batch count, latest root, total events).

```bash
npx hardhat query-state --contract 0x...
npx hardhat query-state --contract 0x... --batch-id 5
```

## Setup

Add to your `hardhat.config.ts`:

```typescript
import "./tasks/deploy-event-anchor";
import "./tasks/submit-batch";
import "./tasks/verify-proof";
import "./tasks/query-state";
```

## Integration with Kernel

These tasks are designed to be called from the kernel's state sync pipeline:

1. **Deploy:** One-time setup per L2 network
2. **Submit batch:** Called by `EventAnchoringService` when a batch is ready
3. **Verify proof:** Called by `StateImportService` to validate L2 state
4. **Query state:** Monitoring and debugging
