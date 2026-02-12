# Smart Contract Payout Flow

## Overview

This document describes the automated bounty payment system using the `BountyPayment` smart contract and GitHub Actions integration.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     BOUNTY PAYMENT FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [GitHub Issue]  →  [/claim Comment]  →  [Smart Contract]      │
│       ↓                                         ↓               │
│  [Work Done]     →  [PR Submitted]    →  [Contract Call]       │
│       ↓                                         ↓               │
│  [PR Merged]     →  [GitHub Action]   →  [Payment Sent]        │
│       ↓                                         ↓               │
│  [Issue Closed]  ←  [Confirmation]    ←  [TX Hash Posted]      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Smart Contract: BountyPayment.sol

### Key Features

1. **Bounty Registration**: Maintainers register bounties with GitHub issue numbers
2. **Claim Mechanism**: Contributors claim bounties by commenting `/claim`
3. **Timeout System**: Claims expire after 14 days without PR submission
4. **Automated Payment**: Payment triggered automatically on PR merge
5. **Multi-Recipient Support**: Split payments for collaborative work
6. **Dispute Resolution**: Maintainer-controlled dispute handling
7. **Multi-Token Support**: Native tokens (ETH/MATIC) and ERC20 tokens (USDC, DAI)

### Contract Roles

| Role | Permissions | Who |
|------|-------------|-----|
| `DEFAULT_ADMIN_ROLE` | Full admin access, pause, withdraw | Project owner/multisig |
| `MAINTAINER_ROLE` | Register bounties, resolve disputes | Core maintainers |
| `PAYOUT_ROLE` | Process claims and payments | GitHub Actions bot |

### State Machine

```
Bounty States:

    Open ─────► Claimed ─────► Completed ─────► Paid
      │           │
      │           └──► Expired ──┐
      │                          │
      └──────────────────────────┴─► Open
      │
      └─────────► Disputed ─────────► Resolved ──► Open or Claimed
      │
      └─────────► Cancelled
```

## Integration Flow

### 1. Bounty Registration (Manual)

**When**: Issue is created with bounty label
**Who**: Maintainer
**Action**: Call `registerBounty()` on smart contract

```solidity
function registerBounty(
    uint256 issueNumber,      // GitHub issue #123
    uint256 amount,           // 250 * 10^18 (250 MATIC)
    address token,            // address(0) for native, or ERC20 address
    string memory metadata,   // JSON with bounty details
    bool isAgentFriendly      // true/false
) external onlyRole(MAINTAINER_ROLE)
```

**Example using Hardhat:**
```typescript
await bountyPayment.registerBounty(
  123,                                    // Issue #123
  ethers.parseEther("250"),              // 250 MATIC
  ethers.ZeroAddress,                    // Native token
  "ipfs://QmBOUNTYMETADATA...",           // Metadata
  true                                    // Agent-friendly
);
```

### 2. Claim Processing (Automated)

**When**: User comments `/claim` on issue
**Who**: GitHub Actions bot
**Action**: Call `claimBounty()` on smart contract

**Workflow**: `.github/workflows/bounty-management.yml`

```yaml
- name: Register claim on smart contract
  run: |
    npx hardhat run scripts/claim-bounty.ts \
      --issue-number ${{ github.event.issue.number }} \
      --claimant ${{ steps.parse.outputs.wallet }} \
      --network polygon
```

**Script**: `scripts/claim-bounty.ts`
```typescript
const tx = await bountyPayment.claimBounty(
  issueNumber,
  claimantWallet
);
await tx.wait();
```

**Contract Function:**
```solidity
function claimBounty(
    uint256 issueNumber,
    address claimant
) external onlyRole(PAYOUT_ROLE)
```

### 3. Claim Expiry (Automated - Daily Cron)

**When**: 14 days after claim without PR
**Who**: GitHub Actions cron job or anyone
**Action**: Call `expireClaim()` on smart contract

```solidity
function expireClaim(
    uint256 issueNumber
) external
```

This is a public function - anyone can call it to clean up expired claims.

### 4. Payment Processing (Automated)

**When**: PR is merged
**Who**: GitHub Actions bot
**Action**: Call `payBounty()` on smart contract

**Workflow**: `.github/workflows/bounty-management.yml`

```yaml
- name: Execute payment on smart contract
  run: |
    npx hardhat run scripts/pay-bounty.ts \
      --issue-number ${{ steps.extract.outputs.issue_number }} \
      --pr-number ${{ github.event.pull_request.number }} \
      --recipient ${{ steps.extract.outputs.wallet }} \
      --network polygon
```

**Script**: `scripts/pay-bounty.ts`
```typescript
const tx = await bountyPayment.payBounty(
  issueNumber,
  prNumber,
  recipientWallet
);
await tx.wait();

// Get transaction hash
const receipt = await tx.wait();
console.log("Payment TX:", receipt.hash);
```

**Contract Function:**
```solidity
function payBounty(
    uint256 issueNumber,
    uint256 prNumber,
    address payable recipient
) external onlyRole(PAYOUT_ROLE) nonReentrant
```

## Multi-Recipient Payments

For collaborative bounties where multiple contributors split the reward:

```typescript
await bountyPayment.payBountyMultiple(
  123,                                      // Issue number
  456,                                      // PR number
  [wallet1, wallet2, wallet3],             // Recipients
  [
    ethers.parseEther("100"),              // 100 MATIC to wallet1
    ethers.parseEther("100"),              // 100 MATIC to wallet2
    ethers.parseEther("50")                // 50 MATIC to wallet3
  ]
);
```

## Dispute Resolution

If a bounty completion is disputed:

### Step 1: Mark as Disputed
```solidity
await bountyPayment.disputeBounty(
  issueNumber,
  "Code quality does not meet acceptance criteria"
);
```

### Step 2: Investigation
- Maintainers review the work
- Contributor addresses feedback
- Community vote for large bounties (optional)

### Step 3: Resolution
```solidity
await bountyPayment.resolveDispute(
  issueNumber,
  true  // true = proceed with payment, false = revert to Open
);
```

## Gas Optimization

### Batching Claims
For multiple bounties, batch operations off-chain:

```typescript
// Instead of:
await bountyPayment.claimBounty(123, wallet);
await bountyPayment.claimBounty(124, wallet);
await bountyPayment.claimBounty(125, wallet);

// Use multicall or similar patterns
```

### ERC20 vs Native Tokens

| Aspect | Native (ETH/MATIC) | ERC20 (USDC) |
|--------|-------------------|--------------|
| **Gas Cost** | ~50,000 gas | ~65,000 gas |
| **Approval** | Not needed | Required once |
| **Volatility** | High | Stable (stablecoin) |
| **Recommended** | Polygon (low gas) | USDC on Polygon |

## Network Configuration

### Supported Networks

| Network | Chain ID | Recommended Token | Gas Cost | Finality |
|---------|----------|-------------------|----------|----------|
| **Polygon** | 137 | MATIC, USDC | Very Low (~$0.01) | ~2 min |
| **Arbitrum One** | 42161 | ETH, USDC | Low (~$0.10) | Instant |
| **Optimism** | 10 | ETH, USDC | Low (~$0.10) | Instant |
| **Base** | 8453 | ETH, USDC | Very Low (~$0.01) | Instant |
| **Ethereum** | 1 | ETH, USDC | High (~$5-50) | ~15 min |

**Recommendation**: Use **Polygon** for primary bounties (low gas, fast, stable).

### Hardhat Configuration

```typescript
// hardhat.config.ts

const config: HardhatUserConfig = {
  networks: {
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      chainId: 137,
      accounts: [process.env.BOUNTY_PRIVATE_KEY!],
      gasPrice: 50000000000, // 50 gwei
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: [process.env.BOUNTY_PRIVATE_KEY!],
    },
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      chainId: 10,
      accounts: [process.env.BOUNTY_PRIVATE_KEY!],
    },
  },
};
```

## Security Considerations

### Access Control
- Only `MAINTAINER_ROLE` can register bounties
- Only `PAYOUT_ROLE` can process claims and payments
- Only `DEFAULT_ADMIN_ROLE` can pause/withdraw in emergencies

### Reentrancy Protection
- `payBounty()` uses `nonReentrant` modifier
- State changes before external calls
- Uses OpenZeppelin's ReentrancyGuard

### Claim Timeout
- Prevents indefinite claim locking
- Automatic expiry after 14 days
- Public `expireClaim()` for decentralized cleanup

### Emergency Controls
- `pause()` / `unpause()` for emergencies
- `withdrawNative()` / `withdrawToken()` for fund recovery
- Only accessible by admin multisig

## Monitoring & Analytics

### On-Chain Events

Monitor these events for analytics:

```solidity
event BountyRegistered(uint256 indexed issueNumber, uint256 amount, ...);
event BountyClaimed(uint256 indexed issueNumber, address indexed claimant, ...);
event BountyPaid(uint256 indexed issueNumber, address indexed recipient, ...);
event BountyExpired(uint256 indexed issueNumber, ...);
event BountyDisputed(uint256 indexed issueNumber, ...);
```

### Subgraph (The Graph)

Deploy a subgraph to index bounty events:

```graphql
type Bounty @entity {
  id: ID!
  issueNumber: BigInt!
  amount: BigInt!
  token: Bytes!
  status: BountyStatus!
  claimant: Bytes
  claimedAt: BigInt
  paidAt: BigInt
  createdAt: BigInt!
}

enum BountyStatus {
  Open
  Claimed
  Completed
  Paid
  Expired
  Disputed
  Cancelled
}
```

### Dashboard Queries

```typescript
// Get all paid bounties
const paidBounties = await bountyPayment.getAllIssueNumbers();
const stats = await bountyPayment.getStats();

console.log("Total Bounties:", stats.totalBounties);
console.log("Total Paid:", ethers.formatEther(stats.totalPaid), "MATIC");
console.log("Contract Balance:", ethers.formatEther(stats.contractBalance));
```

## Testing

### Unit Tests

```typescript
describe("BountyPayment", () => {
  it("should register a bounty", async () => {
    await bountyPayment.registerBounty(123, parseEther("250"), ZeroAddress, "metadata", true);
    const bounty = await bountyPayment.getBounty(123);
    expect(bounty.amount).to.equal(parseEther("250"));
  });

  it("should claim a bounty", async () => {
    await bountyPayment.claimBounty(123, claimant.address);
    const bounty = await bountyPayment.getBounty(123);
    expect(bounty.status).to.equal(BountyStatus.Claimed);
  });

  it("should expire a claim after timeout", async () => {
    await bountyPayment.claimBounty(123, claimant.address);
    await time.increase(15 * 24 * 60 * 60); // 15 days
    await bountyPayment.expireClaim(123);
    const bounty = await bountyPayment.getBounty(123);
    expect(bounty.status).to.equal(BountyStatus.Open);
  });

  it("should pay a bounty", async () => {
    await bountyPayment.payBounty(123, 456, claimant.address);
    const bounty = await bountyPayment.getBounty(123);
    expect(bounty.status).to.equal(BountyStatus.Paid);
  });
});
```

### Integration Tests

Test the full flow with GitHub Actions locally:

```bash
# Install act (GitHub Actions local runner)
npm install -g act

# Run claim workflow
act issue_comment -e test/fixtures/claim-event.json

# Run payment workflow
act pull_request -e test/fixtures/merge-event.json
```

## Cost Analysis

### Per-Bounty Costs (Polygon)

| Operation | Gas Cost | USD Cost (@ 50 gwei, $0.80 MATIC) |
|-----------|----------|-----------------------------------|
| Register Bounty | ~100,000 | ~$0.004 |
| Claim Bounty | ~80,000 | ~$0.003 |
| Expire Claim | ~50,000 | ~$0.002 |
| Pay Bounty (native) | ~50,000 | ~$0.002 |
| Pay Bounty (ERC20) | ~65,000 | ~$0.003 |
| **Total per bounty** | **~280,000** | **~$0.011** |

**Conclusion**: Operating costs are negligible on Polygon (~$0.01 per bounty).

## Troubleshooting

### Common Issues

**Issue**: "Bounty not available"
**Solution**: Check if bounty status is `Open`. May be already claimed or cancelled.

**Issue**: "Insufficient contract balance"
**Solution**: Fund the contract with more tokens using `receive()` or direct transfer.

**Issue**: "Claim has not expired yet"
**Solution**: Wait until 14 days after claim timestamp.

**Issue**: "Recipient must be the claimant"
**Solution**: Ensure the wallet address in payment matches the claim.

## Future Enhancements

### Planned Features

1. **Allo Protocol Integration**: Direct integration with Gitcoin's Allo Protocol
2. **Multi-Milestone Payments**: Split payment across multiple milestones
3. **Staking**: Contributors stake tokens to claim high-value bounties
4. **Reputation System**: On-chain reputation scores for contributors
5. **Automated Quality Checks**: Smart contract verifies test coverage, lint, etc.
6. **Governance**: DAO voting for large bounty disputes

## Support

- **Smart Contract Issues**: Open issue with `bounty-contract` label
- **Payment Problems**: Tag @maintainers with TX hash and issue number
- **Gas Issues**: Consider switching networks or using ERC20 stablecoins

---

**Contract Deployed**: TBD
**Network**: Polygon Mainnet
**Last Updated**: 2026-02-12
