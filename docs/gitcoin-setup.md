# Gitcoin Project Setup Guide

## Overview

This document provides instructions for maintainers on setting up and managing the 0xSCADA Gitcoin bounty program using the Gitcoin Grants Stack and Allo Protocol.

## Prerequisites

- Project multisig wallet (recommended: Gnosis Safe)
- Sufficient funding for bounties (ETH, MATIC, or other supported tokens)
- GitHub maintainer access
- Understanding of smart contract interactions

## Step 1: Project Registration on Gitcoin

### 1.1 Create Gitcoin Account

1. Visit [Gitcoin Grants Stack](https://grants.gitcoin.co/)
2. Connect wallet (use project multisig wallet)
3. Complete project profile:
   - **Project Name**: 0xSCADA
   - **Description**: Decentralized Industrial Control Fabric - Where Atoms Meet Bits
   - **Website**: https://github.com/NickFlach/0xSCADA
   - **Category**: Infrastructure, Web3, Open Source
   - **Tags**: Industrial IoT, SCADA, Blockchain, Smart Contracts, Decentralization

### 1.2 Project Verification

Complete verification requirements:
- GitHub repository linked and verified
- Twitter/social media (optional but recommended)
- Project logo and banner (use assets from /branding)
- Team members added with roles

### 1.3 Configure Allo Protocol

The Allo Protocol powers Gitcoin's bounty distribution:

```bash
# Allo Protocol Registry
# Register 0xSCADA as a project profile

Contract: AlloRegistry (varies by network)
Function: createProfile(
  nonce: uint256,
  name: "0xSCADA",
  metadata: {
    protocol: 1,
    pointer: "ipfs://QmBOUNTYMETADATA..."
  },
  owner: <multisig-address>,
  members: [<member-addresses>]
)
```

## Step 2: Wallet Setup

### 2.1 Multisig Wallet (Recommended)

Create a Gnosis Safe multisig for bounty management:

1. Visit [Gnosis Safe](https://safe.global/)
2. Create new Safe:
   - **Signers**: 3-5 core maintainers
   - **Threshold**: 2-of-3 or 3-of-5
   - **Networks**: Polygon (primary), Arbitrum, Optimism

**Example Configuration:**
```
Safe Address: 0x... (to be determined)
Network: Polygon
Signers:
  - Maintainer 1: 0x...
  - Maintainer 2: 0x...
  - Maintainer 3: 0x...
Threshold: 2/3 confirmations required
```

### 2.2 Fund the Wallet

Transfer initial bounty budget:
- **Recommended**: $10,000-50,000 equivalent in MATIC (Polygon)
- **Gas Reserve**: 100-500 MATIC for transaction fees
- **Multi-chain**: Consider funding on Arbitrum/Optimism for diversity

**Funding Breakdown Example:**
```
Network: Polygon
Token: MATIC

Initial Budget:
- Small Bounties ($50-150): $5,000
- Medium Bounties ($150-500): $10,000
- Large Bounties ($500-1500): $8,000
- XL Bounties ($1500+): $5,000
- Gas Reserve: ~500 MATIC
- Emergency Buffer: $2,000

Total: ~$30,000 + gas
```

## Step 3: Smart Contract Deployment

### 3.1 Bounty Payment Contract

Deploy the automated bounty payment contract:

```solidity
// contracts/BountyPayment.sol

// See full implementation in contracts/BountyPayment.sol
// Key functions:
// - registerBounty(issueNumber, amount, criteria)
// - claimBounty(issueNumber, claimantWallet)
// - payBounty(issueNumber, prNumber, recipient)
// - expireClaim(issueNumber) // after the on-chain timeout
```

**Deployment Networks:**
- Polygon (primary)
- Arbitrum One
- Optimism
- Base

**Deployment Command:**
```bash
forge build
forge create contracts/BountyPayment.sol:BountyPayment \
  --rpc-url "$BOUNTY_RPC_URL" \
  --private-key "$BOUNTY_PRIVATE_KEY" \
  --broadcast
```

Forge is the canonical contract tool for this repository. Record the
`Deployed to:` address as the `BOUNTY_CONTRACT_ADDRESS` repository secret and
verify it with the target network's explorer tooling before enabling payouts.

**Save Deployed Addresses:**
```bash
# .env.bounty-contracts
BOUNTY_CONTRACT_POLYGON=0x...
BOUNTY_CONTRACT_ARBITRUM=0x...
BOUNTY_CONTRACT_OPTIMISM=0x...
BOUNTY_CONTRACT_BASE=0x...
```

### 3.2 Contract Configuration

Configure the bounty contract:

```javascript
// Configure maintainers who can approve payouts
await bountyContract.addMaintainer("0xMAINTAINER1");
await bountyContract.addMaintainer("0xMAINTAINER2");

// Set payment token (MATIC, USDC, etc.)
await bountyContract.setPaymentToken("0xUSDC_ON_POLYGON");

// Configure timeout (14 days default)
await bountyContract.setClaimTimeout(14 * 24 * 60 * 60); // seconds
```

## Step 4: GitHub Integration

### 4.1 GitHub Actions Workflow

Create a workflow for trusted claim handling and explicitly approved payouts:

```yaml
# .github/workflows/bounty-management.yml

name: Bounty Management

on:
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        required: true
        type: string
      issue_number:
        required: true
        type: string
      recipient_wallet:
        required: true
        type: string

jobs:
  handle-bounty-claim:
    # Process /claim comments only after a write-permission check
    # Validate claim format
    # Record the approved wallet and claim state
    # Set timeout

  handle-bounty-payout:
    # Trigger only through workflow_dispatch on the default branch
    # Verify dispatcher authorization and exact merged PR/bounty inputs
    # Call smart contract to pay bounty
    # Post an auditable payment confirmation
```

### 4.2 Bot Configuration

Set up a GitHub bot or GitHub Actions for:
- Claim validation (`/claim` command)
- Timeout tracking (14-day expiry)
- Maintainer-approved payment dispatches
- Status updates

**Required Secrets:**
```bash
# GitHub Repository Secrets
BOUNTY_PRIVATE_KEY        # PAYOUT_ROLE signer
BOUNTY_RPC_URL            # RPC endpoint
BOUNTY_CONTRACT_ADDRESS   # Deployed contract address
```

**Repository Variable:**
```bash
BOUNTY_NETWORK            # Human-readable network name for confirmations
```

### 4.3 Label Automation

Configure automatic label management:
- `bounty:claimed` when claimed
- `bounty:in-progress` during work
- `bounty:ready-for-review` when PR submitted
- `bounty:paid` after payment

## Step 5: Bounty Workflow Automation

### 5.1 Claim Processing

After reviewing a contributor's timeline, approach, and wallet, a repository
participant with write, maintain, or admin permission comments
`/claim @contributor 0xWallet` (or `/agent-claim`):

1. Parse the approval command for:
   - Contributor GitHub username
   - Exact wallet address
2. Find that contributor's earlier proposal and verify:
   - Timeline
   - Approach (for medium+ bounties)
   - The same exact wallet address
3. Validate:
   - Comment passes the association prefilter and its author has repository
     write, maintain, or admin permission
   - Issue has `bounty:*` label
   - Issue not already claimed
   - Wallet address is valid EVM address
4. Register claim in smart contract:
   ```javascript
   await bountyContract.claimBounty(
     issueNumber,
     walletAddress
   );
   ```
5. Add `bounty:claimed` label
6. Record the claimant, approving maintainer, and wallet
7. Set timeout timer (14 days)

### 5.2 Timeout Management

Daily cron job to check for expired claims:

```javascript
// Check for claims older than 14 days without PR
const expiredClaims = await checkExpiredClaims();

for (const claim of expiredClaims) {
  // Release the contract first; do not advertise an on-chain-locked bounty.
  await bountyContract.expireClaim(claim.issueNumber);

  // Remove claimed label
  await github.removeLabel(claim.issueNumber, "bounty:claimed");

  // Comment notification
  await github.createComment(
    claim.issueNumber,
    "This bounty claim has expired (14 days). The bounty is now available for others to claim."
  );
}
```

### 5.3 Payment Processing

After the PR is merged, a maintainer runs `Bounty Management` with the exact PR
number, bounty issue number, and approved recipient wallet:

1. Verify the dispatcher has `admin`, `maintain`, or `write` permission.
2. Verify the workflow is running from the trusted default branch.
3. Verify the PR is merged to the default branch and explicitly closes the
   supplied bounty issue.
4. Verify the issue has a supported bounty tier, is `bounty:claimed`, is not
   `bounty:paid`, and contains a trusted claim for the supplied wallet.
5. Check all acceptance criteria met:
   - All CI checks pass
   - DCO sign-off present
   - Tests pass
   - Code review approved
6. Call smart contract:
   ```javascript
   const tx = await bountyContract.payBounty(
     issueNumber,
     prNumber,
     contributorWallet
   );
   await tx.wait();
   ```
7. Post transaction details:
   ```markdown
   🎉 Bounty paid!

   **Transaction**: https://polygonscan.com/tx/${tx.hash}
   **Recipient**: ${contributorWallet}
   **Amount**: $${bountyAmount}
   **Network**: Polygon

   Thank you for your contribution to 0xSCADA!
   ```
8. Update labels: `bounty:paid`
9. Close issue

## Step 6: Financial Management

### 6.1 Budget Tracking

Maintain a spreadsheet or dashboard:

| Issue | Tier | Amount | Status | Paid Date | TX Hash |
|-------|------|--------|--------|-----------|---------|
| #123 | Medium | $250 | Paid | 2026-02-15 | 0x... |
| #124 | Small | $100 | Claimed | - | - |
| #125 | Large | $750 | Open | - | - |

### 6.2 Replenishment

Monitor wallet balance:
- Set alert threshold (e.g., <$5,000 remaining)
- Refill process through multisig
- Announce budget availability to community

### 6.3 Accounting

For tax/accounting purposes:
- Export all transactions monthly
- Tag transactions by category (bounty payments)
- Maintain records of GitHub usernames → wallet addresses
- Track total payouts by contributor

## Step 7: Community Management

### 7.1 Bounty Board

Create a public bounty dashboard:
- Total bounties available
- Total paid to date
- Active bounties
- Top contributors
- Agent vs human contributions

**Example Dashboard:**
```markdown
## 0xSCADA Bounty Board

**Total Bounties Available**: $47,500
**Total Paid to Date**: $12,350
**Active Bounties**: 23
**Completed Bounties**: 87

### Top Contributors (All Time)
1. alice.eth - $3,240 (12 bounties)
2. bob.eth - $2,150 (8 bounties)
3. Claude Opus 4.6 (AI) - $1,890 (11 bounties)
```

### 7.2 Communication Channels

Set up dedicated channels:
- **Discord/Telegram**: `#bounties` channel
- **GitHub Discussions**: "Bounty Program" category
- **Twitter/X**: Regular bounty announcements
- **Newsletter**: Monthly bounty digest

### 7.3 Feedback Loop

Collect feedback quarterly:
- Survey contributors about bounty experience
- Adjust bounty amounts based on market rates
- Refine acceptance criteria based on learnings
- Improve automation based on pain points

## Step 8: Security & Compliance

### 8.1 Security Measures

- **Multisig**: Always use multisig for fund management
- **Audit**: Have bounty contract audited before launch
- **Limits**: Set max bounty payment per transaction
- **Rate Limits**: Prevent spam/abuse of claim system

### 8.2 Legal Compliance

Consult with legal counsel regarding:
- Tax implications of bounty payments
- Contributor status (contractor vs employee)
- International payments
- KYC/AML requirements for large payments

### 8.3 Dispute Resolution

Document clear process:
1. Contributor submits dispute in issue comments
2. Maintainer provides specific feedback within 48 hours
3. Contributor has 7 days to address
4. Community vote for large bounties if needed
5. Final decision by project maintainers
6. Escalation path for serious disputes

## Step 9: Metrics & Analytics

Track key metrics:

### Participation Metrics
- Total bounties claimed
- Claim → completion rate
- Average time to completion
- First-time vs returning contributors

### Quality Metrics
- PR approval rate (first submission)
- Average review cycles
- Test coverage in bounty PRs
- Bug rate in bounty contributions

### Financial Metrics
- Total payouts per month
- Average bounty amount
- Cost per contribution
- ROI on bounty program

### Agent Metrics
- AI agent participation rate
- Agent vs human completion quality
- Agent specializations
- Human + AI collaboration instances

## Step 10: Scaling the Program

As the program grows:

### Tier Adjustments
- Review bounty tier amounts quarterly
- Adjust based on market rates and complexity
- Consider specialized high-value bounties ($5k+)

### Automation Improvements
- Implement AI-powered acceptance criteria checking
- Automatic test coverage validation
- Smart contract-based escrow for large bounties
- Multi-signature requirements for XL bounties

### Partnerships
- Collaborate with other Gitcoin projects
- Cross-project bounties
- Shared bounty pools for ecosystem work
- Hackathon integrations

## Resources

### Gitcoin Documentation
- [Grants Stack](https://support.gitcoin.co/gitcoin-knowledge-base/gitcoin-grants)
- [Allo Protocol](https://docs.allo.gitcoin.co/)
- [Builder Docs](https://support.gitcoin.co/gitcoin-knowledge-base/gitcoin-grants/builder)

### Smart Contract Examples
- [Allo Protocol Registry](https://github.com/allo-protocol/allo-v2)
- [Bounty Standards](https://github.com/Bounties-Network/StandardBounties)

### Tools
- [Gnosis Safe](https://safe.global/)
- [Polygonscan](https://polygonscan.com/)
- [GitHub Actions Marketplace](https://github.com/marketplace?type=actions)

## Troubleshooting

### Common Issues

**Claim not processing:**
- Check wallet address format (must be valid EVM address)
- Verify issue has `bounty:*` label
- Ensure issue not already claimed

**Payment failed:**
- Check multisig wallet has sufficient funds
- Verify gas fee reserves
- Check RPC endpoint connectivity
- Verify smart contract not paused

**Agent claim denied:**
- Agent may need to register profile first
- Check agent metadata format
- Verify agent meets eligibility criteria

## Support

For setup questions:
- **Gitcoin Support**: support@gitcoin.co
- **Allo Protocol**: [Discord](https://discord.gg/gitcoin)
- **0xSCADA Maintainers**: Tag @maintainers in GitHub issue

---

**Last Updated**: 2026-02-12
**Maintained By**: 0xSCADA Core Team
