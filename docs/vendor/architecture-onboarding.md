# 0xSCADA Architecture & Contribution Onboarding

> Issue #28 — [Vendor/Core] 0xSCADA Architecture & Contribution Onboarding

## Welcome

0xSCADA is an open-source industrial SCADA platform that combines OT (Operational Technology) data acquisition with blockchain-based data integrity, AI agents, and modern web technologies.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Client (React + Vite)                │
│   Dashboard  │  Digital Twin  │  Ladder Logic  │  Alarms    │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP / WebSocket
┌───────────────────────▼─────────────────────────────────────┐
│                     Server (Express + TypeScript)            │
│                                                             │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Routes   │  │  Agents   │  │ Gateway  │  │ Blockchain│  │
│  │  API      │  │  AI/Gov   │  │ OPC-UA   │  │ Anchoring │  │
│  │          │  │           │  │ Modbus   │  │ Artifacts │  │
│  └──────────┘  └───────────┘  │ DNP3     │  └───────────┘  │
│                               │ IEC61850 │                  │
│                               └──────────┘                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Database (PostgreSQL + Drizzle ORM)                 │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Repository Structure

```
0xSCADA/
├── client/              # React frontend (Vite, Tailwind, shadcn/ui)
├── server/              # Express backend
│   ├── agents/          # AI governance agents (compliance, ops, change control)
│   ├── blueprints/      # Ladder logic, vendor adapters (Rockwell, Siemens)
│   ├── gateway/         # Protocol drivers (OPC-UA, Modbus, DNP3, IEC 61850)
│   └── integrations/    # External service clients (Azure IoT, etc.)
├── shared/              # Shared types and schemas
├── blockchain/          # Smart contracts, blockchain anchoring
├── contracts/           # Solidity contracts
├── docker/              # Docker deployment configs
│   ├── edge/            # Edge deployment (Dockerfile, compose)
│   └── grafana/         # Grafana dashboard definitions
├── docs/                # Documentation
│   ├── architecture/    # Architecture decisions
│   ├── decisions/       # ADRs (Architecture Decision Records)
│   ├── observability/   # Metrics, Grafana dashboards
│   ├── optix/           # Optix/IoT/Edge integration docs
│   └── vendor/          # Vendor learning tracts
├── kernel/              # RT kernel patches
├── scripts/             # Build and deployment scripts
├── test/                # Test suites
└── packages/            # Monorepo packages
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL, Drizzle ORM |
| Blockchain | Hardhat, Solidity, Ethereum (Clique PoA) |
| Protocols | OPC-UA (node-opcua), Modbus, DNP3, IEC 61850 |
| AI Agents | Custom agent framework, LLM integration |
| Deployment | Docker, Docker Compose |

## Development Setup

### Prerequisites
- Node.js 20+
- PostgreSQL 16+
- Git

### Quick Start

```bash
# Clone
git clone https://github.com/NickFlach/0xSCADA.git
cd 0xSCADA

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your database URL, etc.

# Run database migrations
npm run db:push

# Start development server
npm run dev
```

The app runs at `http://localhost:5000` with hot reload for both client and server.

### Key Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm run test` | Run test suite (Vitest) |
| `npm run db:push` | Push schema to database |

## Development Workflow

### Branching Strategy
- `main` — stable, deployable
- `feat/<name>` — feature branches
- `fix/<name>` — bug fixes

### Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make changes and add tests
4. Commit with conventional commits: `feat: add modbus polling mode`
5. Push and open a Pull Request
6. Reference the issue: `Closes #XX`

### Code Style
- TypeScript strict mode
- ESLint + Prettier (if configured)
- Meaningful variable names, JSDoc for public APIs
- Each module should have a header comment describing its purpose and issue number

### Architecture Decision Records
Major decisions are documented in `docs/decisions/ADR-XXXX-*.md`. When making architectural changes, create a new ADR following `docs/decisions/_template.md`.

## Testing

```bash
# Run all tests
npm run test

# Run with coverage
npx vitest --coverage

# Run specific test file
npx vitest server/gateway/opcua-subscription-manager.test.ts
```

- Unit tests live alongside source files or in `test/`
- Use Vitest (configured in `vitest.config.ts`)
- Mock external dependencies (OPC-UA servers, databases)

## Deployment

### Docker (Recommended)

```bash
# Full stack
docker-compose up -d

# Edge-only
docker-compose -f docker/edge/docker-compose.yml up -d
```

### Manual

```bash
npm run build
NODE_ENV=production node dist/index.js
```

## Key Concepts for New Contributors

### Gateway Drivers
Protocol drivers in `server/gateway/` follow a common pattern:
- Connection management (connect, disconnect, reconnect)
- Read/write operations
- Subscription/polling for data changes
- Event emission for data updates

### Agent Framework
AI agents in `server/agents/` handle governance:
- **Compliance Agent** — Regulatory compliance checks
- **Ops Agent** — Operational intelligence
- **Change Control Agent** — Change management workflow
- **Zero Trust Guard** — Security enforcement

### Blockchain Anchoring
Data integrity via blockchain:
- Merkle tree batching for efficient anchoring
- Artifact NFTs for certified process data
- Clique PoA consensus for private networks

## Getting Help

- Read the ADRs in `docs/decisions/` for architectural context
- Check existing issues on GitHub
- Review `CONTRIBUTING.md` for detailed guidelines
- See `docs/` for specific subsystem documentation
