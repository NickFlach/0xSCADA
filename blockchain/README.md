# 0xSCADA Custom Blockchain

Custom Ethereum fork for the 0xSCADA industrial SCADA platform.

## Specifications

| Parameter | Value |
|-----------|-------|
| Chain ID | 380634 (0x5CADA) |
| Consensus | Clique (Proof of Authority) |
| Block Time | 5 seconds |
| Epoch | 30,000 blocks |
| Gas Limit | 30,000,000 |

## Quick Start

### 1. Initialize the Chain

```bash
cd blockchain
./init-chain.sh
```

### 2. Import the Signer Key

Import the Hardhat default account #0 private key:

```bash
./import-key.sh
```

You'll be prompted for a password. **Remember this password!**

### 3. Start the Node

```bash
SIGNER_PASSWORD=your_password ./start-node.sh
```

## Pre-funded Accounts

The genesis block pre-funds the first 5 Hardhat development accounts with 10,000 ETH each.
These are the standard Hardhat accounts — see the [Hardhat documentation](https://hardhat.org/hardhat-network/docs/reference#initial-state) for the full list.

| Account | Address |
|---------|---------|
| #0 (Signer) | 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 |
| #1 | 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 |
| #2 | 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC |
| #3 | 0x90F79bf6EB2c4f870365E785982E1f101E93b906 |
| #4 | 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 |

> **Warning**: These are well-known development accounts. **Never use them in production!** Private keys are available in the Hardhat docs — do not hardcode them in your config. Use `process.env.PRIVATE_KEY` instead.

## Security Best Practices

### Signer Management

1. **Use environment variables** for passwords, never hardcode them
2. **Run signer nodes on localhost** - RPC/WS bind to 127.0.0.1 by default
3. **Dedicated signer node** - Consider running a separate node just for signing
4. **Keystore security** - Protect the `data/keystore/` directory

### Remote Access (Development Only)

If you need remote RPC access for development:

```bash
SIGNER_PASSWORD=your_password ALLOW_REMOTE_ACCESS=true ./start-node.sh
```

> **Warning**: This enables `--allow-insecure-unlock`. Only use in secured development environments!

### Production Recommendations

1. Use a hardware wallet or HSM for signer keys
2. Implement proper firewall rules
3. Consider running behind a reverse proxy with authentication
4. Regular key rotation and access audits

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| SIGNER_ADDRESS | 0xf39F...2266 | Address of the PoA signer |
| SIGNER_PASSWORD | (required) | Password to unlock signer account |
| HTTP_ADDR | 127.0.0.1 | HTTP RPC bind address |
| WS_ADDR | 127.0.0.1 | WebSocket bind address |
| ALLOW_REMOTE_ACCESS | false | Enable 0.0.0.0 binding (insecure) |

## Connecting to the Node

### ethers.js

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('http://localhost:8545');
const signer = new ethers.Wallet(privateKey, provider);
```

### Hardhat

Update `hardhat.config.cts`:

```typescript
networks: {
  scada: {
    url: 'http://localhost:8545',
    chainId: 380634,
    accounts: [process.env.PRIVATE_KEY]
  }
}
```

## Clique Consensus

Clique is a Proof of Authority consensus mechanism:

- **Validators**: Only authorized signers can produce blocks
- **Block time**: Fixed 5-second intervals
- **No mining**: No PoW computation required
- **Epoch**: Signer list checkpointed every 30,000 blocks

### Adding/Removing Signers

Use the Clique RPC API:

```javascript
// Propose adding a new signer
await provider.send('clique_propose', [newSignerAddress, true]);

// Propose removing a signer
await provider.send('clique_propose', [signerAddress, false]);
```

Proposals require 50%+ of current signers to pass.

## Files

- `genesis.json` - Chain genesis configuration
- `init-chain.sh` - Initialize blockchain data directory
- `start-node.sh` - Start the geth node
- `create-account.sh` - Create new account
- `import-key.sh` - Import private key
- `data/` - Blockchain data (created after init)

## Customization

### Modify Block Time

Edit `genesis.json` and change `config.clique.period`:

```json
"clique": {
  "period": 3,  // 3 seconds
  "epoch": 30000
}
```

### Modify Gas Limit

Edit `genesis.json` and change `gasLimit`:

```json
"gasLimit": "0x2FAF080"  // 50,000,000
```

### Add Initial Signers

Update the `extradata` field in `genesis.json`. Format:
- 32 bytes: vanity (zeros)
- N * 20 bytes: signer addresses (without 0x prefix)
- 65 bytes: signature (zeros for genesis)

After any changes, re-initialize with `./init-chain.sh`.
