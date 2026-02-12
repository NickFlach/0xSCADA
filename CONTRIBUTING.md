# Contributing to 0xSCADA

Thank you for your interest in contributing to 0xSCADA! We're building a decentralized public utility for industrial control systems, and we'd love your help.

## Table of Contents

- [Developer Certificate of Origin](#developer-certificate-of-origin)
- [Gitcoin Bounties](#gitcoin-bounties)
- [Learning Tracks](#learning-tracks)
- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Adding New Vendors](#adding-new-vendors)

---

## Developer Certificate of Origin

This project uses the **Developer Certificate of Origin (DCO)** for all contributions. The DCO is a lightweight way for contributors to certify that they wrote or otherwise have the right to submit the code they are contributing.

### The DCO Text

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### How to Sign Off Your Commits

You must sign off each commit with your real name and email address:

```bash
git commit -s -m "feat(component): add new feature"
```

This adds a `Signed-off-by` line to your commit message:

```
feat(component): add new feature

Signed-off-by: Your Name <your.email@example.com>
```

### Configure Git for Automatic Sign-Off

Set up your Git identity:

```bash
git config --global user.name "Your Real Name"
git config --global user.email "your.email@example.com"
```

### Fixing Unsigned Commits

If you forgot to sign off commits, you can amend the most recent:

```bash
git commit --amend -s
```

Or rebase to sign off multiple commits:

```bash
git rebase --signoff HEAD~3  # Sign off last 3 commits
```

### Why DCO?

The DCO was created by the Linux kernel community as a simple way to track contributions. It provides:

- **Legal clarity** - Clear provenance of all contributions
- **Lightweight process** - No CLAs or legal paperwork required
- **Industry standard** - Used by Linux kernel, Kubernetes, and many major projects

All pull requests are automatically checked for DCO compliance. PRs without proper sign-off will not be merged.

---

## Gitcoin Bounties

0xSCADA offers **paid bounties** through Gitcoin for both **human contributors** and **autonomous AI agents**. Get compensated for your contributions to decentralized industrial infrastructure.

### Overview

- **Platform**: Gitcoin Grants Stack / Allo Protocol
- **Payment**: Cryptocurrency (Ethereum L2s for low gas fees)
- **Eligibility**: Open to all contributors (humans and verified AI agents)
- **Process**: Claim → Complete → Review → Merge → Get Paid

### Bounty Tiers

Issues are labeled with bounty tiers based on complexity and impact:

| Label | Typical Value | Complexity | Examples |
|-------|--------------|------------|----------|
| `bounty:small` | $50-150 | Low | Bug fixes, docs, simple features |
| `bounty:medium` | $150-500 | Medium | New vendor adapters, API endpoints, moderate features |
| `bounty:large` | $500-1500 | High | Major features, smart contracts, kernel modules |
| `bounty:xl` | $1500+ | Very High | Multi-phase initiatives, architectural work, security audits |

**Note**: Exact bounty amounts are specified in each issue's description and may vary based on scope.

### How to Claim a Bounty (Humans)

1. **Find a Bounty Issue**
   - Browse issues with `bounty:*` labels on [GitHub Issues](https://github.com/NickFlach/0xSCADA/issues)
   - Check that the issue is not already assigned
   - Ensure you meet the stated requirements

2. **Claim the Issue**
   - Comment on the issue: `/claim`
   - Include:
     - Your estimated completion timeline
     - Your approach/plan (for medium+ bounties)
     - Your wallet address for payout (EVM-compatible: Ethereum, Polygon, Arbitrum, Optimism, Base)
   - **Example**:
     ```
     /claim

     Timeline: 5 days
     Approach: Will implement Schneider Electric adapter following existing pattern from Siemens/Rockwell adapters
     Wallet: 0x1234...5678
     ```

3. **Work on the Issue**
   - Follow the [Making Changes](#making-changes) guidelines
   - Ensure all commits are signed off (DCO)
   - Meet the acceptance criteria listed in the issue
   - Communicate progress in the issue comments

4. **Submit Your Work**
   - Create a pull request referencing the issue: `Closes #<issue-number>`
   - Fill out the PR template completely
   - All tests must pass
   - Code must meet quality standards

5. **Review & Payment**
   - Maintainers review your PR within 48-72 hours
   - Address any requested changes
   - Once merged, payment is processed automatically via smart contract
   - Expected payout time: 24-48 hours after merge
   - You'll receive a transaction hash as proof of payment

### How to Claim a Bounty (AI Agents)

AI agents can autonomously claim and complete bounties using our **Agent-Friendly Bounty Protocol**. See full documentation in the [AI Agent Bounty Guide](docs/ai-agent-bounty-guide.md).

**Quick Start for Agents:**
1. Discover bounties via GitHub API filtering for `bounty:*` labels
2. Claim by commenting `/agent-claim` with agent metadata
3. Include wallet registration in claim
4. Submit PR with automated test verification
5. Receive payment upon merge

**Agent Requirements:**
- Must have a verified wallet address for payouts
- Must include agent metadata in claim (model, version, capabilities)
- Must pass all automated acceptance criteria
- Must operate within ethical guidelines (no spam, gaming, or abuse)

### Bounty Claim Timeout

- **Claimed bounties expire after 14 days** without significant progress
- If you need an extension, comment on the issue explaining why
- Expired claims are automatically released for others to claim
- You can re-claim after addressing blockers

### Acceptance Criteria

All bounties have clear acceptance criteria that must be met:

✅ **Required**:
- All tests pass (unit, integration, e2e as applicable)
- Code meets project coding standards
- Documentation updated (if applicable)
- DCO sign-off on all commits
- PR template fully completed
- No breaking changes (unless explicitly required)

🎯 **Bounty-Specific**:
- Each issue lists specific requirements
- For code generation: output must match vendor specifications
- For smart contracts: must pass security audit requirements
- For kernel modules: must not introduce regressions

### Dispute Resolution

If there's disagreement about bounty completion:
1. Maintainer provides specific feedback on what's missing
2. Contributor has 7 days to address feedback
3. If unresolved, the issue goes to community vote (for large+ bounties)
4. Final decision rests with project maintainers

### Bounty Workflow Example

```bash
# 1. Find and claim a bounty
# Comment on issue #123: "/claim Timeline: 3 days, Wallet: 0xABC..."

# 2. Create your branch
git checkout -b feature/issue-123-add-abb-adapter

# 3. Do the work
# ... implement the feature ...

# 4. Commit with DCO sign-off
git commit -s -m "feat(blueprints): add ABB AC500 adapter

Implements ABB structured text generation for control modules
and phases following ISA-88 patterns.

Closes #123

Signed-off-by: Your Name <you@example.com>"

# 5. Push and create PR
git push origin feature/issue-123-add-abb-adapter

# 6. Create PR on GitHub with:
# - Title: "feat(blueprints): add ABB AC500 adapter"
# - Description: Reference issue #123
# - Confirm all acceptance criteria met

# 7. Respond to review feedback
# ... make any requested changes ...

# 8. Once merged: Receive payment automatically! 🎉
```

### Wallet Setup

To receive bounty payments, you need an **EVM-compatible wallet**:

**Recommended Wallets:**
- MetaMask (browser extension)
- WalletConnect-compatible mobile wallets
- Hardware wallets (Ledger, Trezor)
- For AI agents: Programmatically managed EOA accounts

**Supported Networks** (for payout):
- Ethereum Mainnet (high gas)
- Polygon (low gas, recommended)
- Arbitrum One (low gas, recommended)
- Optimism (low gas)
- Base (low gas)
- 0x5CADA Chain (our custom chain, experimental)

**Never share your private key**. Only provide your public wallet address.

### Multi-Contributor Bounties

Some large bounties may be split among multiple contributors:
- Original claimer gets priority if making good progress
- Can request help by tagging others in issue
- Payment split is agreed upon before work starts
- Smart contract supports multi-recipient payouts

### Questions About Bounties?

- General questions: Open a [Discussion](https://github.com/NickFlach/0xSCADA/discussions)
- Specific bounty questions: Comment on the issue
- Payment issues: Tag @maintainers in the issue or PR
- Smart contract issues: See [contracts/README.md](contracts/README.md)

---

## Learning Tracks

OxSCADA is structured around **6 learning tracks** designed to help you grow while contributing:

| Track | Focus | Entry Skills | Labels |
|-------|-------|--------------|--------|
| **A - Frontend** | React, visualization, UX | JavaScript basics | `track:frontend` |
| **B - Backend** | APIs, databases, services | TypeScript basics | `track:backend` |
| **C - Blockchain** | Smart contracts, consensus | JS + crypto basics | `track:blockchain` |
| **D - Systems** | Kernel, drivers, security | Linux + C basics | `track:systems` |
| **E - Automation** | PLCs, HMI, control systems | Programming basics | `track:automation` |
| **Q - Quality** | Testing, automation, QE | Testing basics | `track:quality` |

### Finding Issues by Track

```bash
# Good first issues for beginners
label:"good-first-issue" label:"track:frontend"

# Issues for your track and level
label:"track:backend" label:"difficulty:intermediate"

# Phase-specific issues
label:"phase:6-realtime"
```

### Level Progression

Each track has 4 levels. Complete issues at each level to earn badges:

| Level | Badge | Description |
|-------|-------|-------------|
| 1 | Foundation | 3-5 beginner issues |
| 2 | Core | 5-8 intermediate issues |
| 3 | Advanced | 5-8 advanced issues |
| 4 | Expert | 3-5 expert issues |

See [docs/ROADMAP.md](docs/ROADMAP.md) for detailed track curricula.

---

## Code of Conduct

This project adheres to a code of conduct. By participating, you are expected to uphold this code. Please be respectful and constructive in all interactions.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Git

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/0xSCADA.git
   cd 0xSCADA
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/The-ESCO-Group/0xSCADA.git
   ```

## Development Setup

### Install Dependencies

```bash
npm install
```

### Environment Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

Configure the following variables:
```env
DATABASE_URL=postgresql://user:password@localhost:5432/oxscada
HARDHAT_RPC_URL=http://127.0.0.1:8545
```

### Database Setup

Push the schema to your database:
```bash
npm run db:push
```

### Start Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:5000`.

## Project Structure

```
0xSCADA/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/    # UI components
│   │   ├── pages/         # Page components
│   │   ├── lib/           # Utilities and API client
│   │   └── hooks/         # Custom React hooks
├── server/                 # Express backend
│   ├── blueprints/        # Code generation engine
│   │   ├── code-generator.ts
│   │   ├── rockwell-adapter.ts
│   │   ├── siemens-adapter.ts
│   │   └── parsers/
│   ├── routes.ts          # API routes
│   └── storage.ts         # Database operations
├── shared/                 # Shared types and schema
│   └── schema.ts          # Drizzle ORM schema
├── contracts/             # Solidity smart contracts
└── docs/                  # Documentation
```

## Making Changes

### Branch Naming

Use descriptive branch names with track prefix:
```
track-[a-q]/issue-[number]-[short-description]

Examples:
track-a/issue-42-trend-chart        # Frontend issue
track-b/issue-103-opcua-driver      # Backend issue
track-c/issue-77-merkle-proof       # Blockchain issue
```

Alternative formats for non-track work:
- `feature/add-vendor-support`
- `fix/code-generation-bug`
- `docs/update-api-reference`

### Creating a Branch

```bash
git checkout -b feature/your-feature-name
```

### Commit Messages

Follow conventional commits:
```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting
- `refactor`: Code restructuring
- `test`: Adding tests
- `chore`: Maintenance

Examples:
```
feat(blueprints): add ABB vendor adapter
fix(codegen): correct data type mapping for TIME
docs(api): update endpoint documentation
```

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Enable strict mode
- Define explicit types (avoid `any`)
- Use interfaces for object shapes

```typescript
// Good
interface ControlModuleType {
  id: string;
  name: string;
  inputs: IODefinition[];
}

// Avoid
const cm: any = { ... };
```

### React Components

- Use functional components with hooks
- Use TypeScript for props
- Keep components focused and small

```tsx
interface StatCardProps {
  label: string;
  value: number;
  icon: React.ElementType;
}

function StatCard({ label, value, icon: Icon }: StatCardProps) {
  return (
    <div className="...">
      <Icon className="..." />
      <span>{value}</span>
      <span>{label}</span>
    </div>
  );
}
```

### API Routes

- Use async/await
- Handle errors with try/catch
- Return consistent response formats

```typescript
app.get("/api/resource", async (req, res) => {
  try {
    const data = await storage.getResource();
    res.json(data);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to fetch resource" });
  }
});
```

### Database

- Use Drizzle ORM for all database operations
- Define schema in `shared/schema.ts`
- Use transactions for multi-step operations

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Writing Tests

Place tests in `__tests__` directories or use `.test.ts` suffix:

```typescript
import { describe, it, expect } from 'vitest';

describe('CodeGenerator', () => {
  it('should generate valid SCL code', () => {
    const result = generateSCL(mockCMType);
    expect(result).toContain('FUNCTION_BLOCK');
  });
});
```

### Test Categories

1. **Unit Tests**: Test individual functions/components
2. **Integration Tests**: Test API endpoints
3. **E2E Tests**: Test complete user flows

## Submitting Changes

### Pull Request Process

1. Update your fork:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```

3. Create a Pull Request on GitHub

4. Fill out the PR template:
   - Description of changes
   - Related issues
   - Testing performed
   - Screenshots (if UI changes)

### PR Requirements

- [ ] All commits signed off (DCO)
- [ ] All tests pass
- [ ] Code follows style guidelines
- [ ] Documentation updated (if needed)
- [ ] No merge conflicts
- [ ] Reviewed by at least one maintainer

### Review Process

1. Automated checks run (lint, tests)
2. Maintainer reviews code
3. Address feedback
4. Merge when approved

## Adding New Vendors

To add support for a new PLC vendor:

1. Create adapter in `server/blueprints/`:
   ```typescript
   // server/blueprints/new-vendor-adapter.ts
   export class NewVendorAdapter {
     generateControlModule(cm: ControlModuleType): string { ... }
     generatePhase(phase: PhaseType): string { ... }
   }
   ```

2. Add data type mappings in `seed-database.ts`

3. Register in code generator:
   ```typescript
   // code-generator.ts
   case 'new-vendor':
     return new NewVendorAdapter().generateControlModule(cm);
   ```

4. Add tests for the new adapter

5. Update documentation

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions
- Check existing issues before creating new ones

Thank you for contributing! 🎉
