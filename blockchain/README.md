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

The genesis block pre-funds the first 5 Hardhat development accounts with 10,000 ETH each:

| Account | Address | Private Key |
|---------|---------|-------------|
| #0 (Signer) | 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 | 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 |
| #1 | 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 | 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d |
| #2 | 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC | 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a |
| #3 | 0x90F79bf6EB2c4f870365E785982E1f101E93b906 | 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 |
| #4 | 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 | 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a |

> **Warning**: These are well-known development keys. Never use them in production!

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
