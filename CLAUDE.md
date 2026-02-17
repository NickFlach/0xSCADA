# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install              # Install dependencies
npm run dev              # Start development server (port 5000)
npm run build            # Build for production
npm run start            # Run production build

npm run db:push          # Push Drizzle schema to database
npm run check            # TypeScript type checking
npm run lint             # TypeScript type checking (alias)
```

## Testing Commands

```bash
npm test                 # Run all tests (vitest)
npm run test:unit        # Run unit tests
npm run test:integration # Run integration tests
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report

# Run single test file
npx vitest run path/to/file.test.ts

# Run tests matching pattern
npx vitest run -t "pattern"
```

## Architecture Overview

**0xSCADA** is a decentralized industrial control fabric combining:
- **Web Dashboard**: React 19 + TanStack Query + Radix UI + Tailwind CSS
- **API Server**: Express + Drizzle ORM + PostgreSQL
- **Blockchain Layer**: Custom Ethereum fork (Chain ID 0x5CADA) with Clique PoA, 5s blocks
- **Code Generation**: Multi-vendor PLC code (Siemens SCL, Rockwell L5X, Ladder Logic)
- **Batch Anchoring**: Merkle tree batching for 95-99% gas savings on event anchoring

### Key Directories

```
client/src/           # React frontend
  components/         # UI components (shadcn/ui style)
  pages/              # Route pages
  hooks/              # Custom React hooks
  lib/                # Utilities and API client

server/               # Express backend
  routes.ts           # All API route definitions
  storage.ts          # Database operations (Drizzle)
  blueprints/         # ISA-88 code generation engine
    code-generator.ts # Core generator
    siemens-adapter.ts
    rockwell-adapter.ts
  agents/             # Agentic governance (Ops, ChangeControl, Compliance)
  batch-anchoring.ts  # Merkle batch service
  merkle/             # Merkle tree implementation

shared/               # Shared between client/server
  schema.ts           # Drizzle ORM schema (PostgreSQL)
  types/              # TypeScript type definitions

contracts/            # Solidity smart contracts
geth-fork/            # Custom go-ethereum fork
kernel/               # Linux kernel build scripts (PREEMPT_RT)
cli/                  # 0xscada CLI tool
```

### Data Flow

1. Industrial events come from PLCs/RTUs (or simulator)
2. Events queued for Merkle batch anchoring
3. Batches anchor Merkle roots to blockchain (not individual events)
4. Individual events verified via Merkle proofs

## Code Conventions

- **TypeScript strict mode** - No `any`, explicit types, interfaces for shapes
- **Drizzle ORM** - All DB operations through `server/storage.ts`
- **Zod validation** - All API inputs validated
- **Path aliases**: `@/*` = `client/src/*`, `@shared/*` = `shared/*`
- **Tests**: Place in `__tests__/` dirs or use `.test.ts` suffix

## Issue Tracking (bd/beads)

This project uses **bd** for issue tracking:

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Session Completion (Landing the Plane)

When ending a work session, ALWAYS:
1. File issues for remaining work
2. Run quality gates if code changed
3. Update issue status
4. **PUSH TO REMOTE** (mandatory):
   ```bash
   git pull --rebase && bd sync && git push
   ```
5. Verify `git status` shows "up to date with origin"

## Integrity Rule

- NO shortcuts, fake data, or false claims
- ALWAYS implement actual code/tests (no mocks for integration tests)
- ALWAYS verify before claiming success
- ALWAYS run tests, don't assume they pass

## Adding New Vendors

1. Create adapter in `server/blueprints/[vendor]-adapter.ts`
2. Add data type mappings in seed data
3. Register in `code-generator.ts` switch statement
4. Add tests for the adapter
