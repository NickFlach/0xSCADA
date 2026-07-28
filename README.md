<div align="center">

```
 ██████╗ ██╗  ██╗███████╗ ██████╗ █████╗ ██████╗  █████╗ 
██╔═████╗╚██╗██╔╝██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗
██║██╔██║ ╚███╔╝ ███████╗██║     ███████║██║  ██║███████║
████╔╝██║ ██╔██╗ ╚════██║██║     ██╔══██║██║  ██║██╔══██║
╚██████╔╝██╔╝ ██╗███████║╚██████╗██║  ██║██████╔╝██║  ██║
 ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝
```

<br/>

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Share+Tech+Mono&size=22&pause=1000&color=00FF9C&center=true&vCenter=true&width=700&lines=%3E+DECENTRALIZED+INDUSTRIAL+CONTROL+FABRIC;%3E+IMMUTABLE+%E2%80%A2+TAMPER-EVIDENT+%E2%80%A2+TRUSTLESS;%3E+WHERE+ATOMS+MEET+BITS)](https://git.io/typing-svg)

<br/>

![VERSION](https://img.shields.io/badge/VERSION-v2.0.0-00FF9C?style=for-the-badge&labelColor=0D0D0D&logo=semver&logoColor=00FF9C)
![CHAIN ID](https://img.shields.io/badge/CHAIN_ID-0x5CADA-c592ff?style=for-the-badge&labelColor=0D0D0D&logo=ethereum&logoColor=c592ff)
![KERNEL](https://img.shields.io/badge/KERNEL-6.19--rc5-0ABDC9?style=for-the-badge&labelColor=0D0D0D&logo=linux&logoColor=0ABDC9)

<br/>

![License](https://img.shields.io/badge/LICENSE-APACHE_2.0-ff4081?style=flat-square&labelColor=100D23)
![TypeScript](https://img.shields.io/badge/TYPESCRIPT-5.0-00FF9C?style=flat-square&labelColor=100D23&logo=typescript&logoColor=00FF9C)
![React](https://img.shields.io/badge/REACT-18-0ABDC9?style=flat-square&labelColor=100D23&logo=react&logoColor=0ABDC9)
![Solidity](https://img.shields.io/badge/SOLIDITY-0.8-c592ff?style=flat-square&labelColor=100D23&logo=solidity&logoColor=c592ff)
![PostgreSQL](https://img.shields.io/badge/POSTGRESQL-15-ff4081?style=flat-square&labelColor=100D23&logo=postgresql&logoColor=ff4081)
![Go](https://img.shields.io/badge/GO-1.21-00FF9C?style=flat-square&labelColor=100D23&logo=go&logoColor=00FF9C)
![Linux](https://img.shields.io/badge/LINUX-PREEMPT__RT-0ABDC9?style=flat-square&labelColor=100D23&logo=linux&logoColor=0ABDC9)

---

<sub>

**[ [INITIALIZE](#-initialize) • [ARCHITECTURE](#-architecture) • [STACK](#-stack) • [AGENTS](#-agents) • [DOCS](#-docs) • [DEVELOP](#-develop) • [EVOLUTION](#-evolution) ]**

</sub>

</div>

---

<br/>

## ▓▓ TRANSMISSION

```diff
+ "Privacy is necessary for an open society in the electronic age."
+ "We the Cypherpunks are dedicated to building anonymous systems."
+ "Code is speech. Code is infrastructure. Code is law."
+
! — adapted from 'A Cypherpunk's Manifesto', Eric Hughes, 1993
```

<br/>

**0xSCADA** is a decentralized industrial control protocol. SCADA monitoring fused with blockchain integrity, AI agents, and production-scale infrastructure. Built for real-world industrial environments.

This is not a product. This is a **protocol** — where the machines that pump your water, refine your fuel, and generate your electricity are governed by transparent, immutable, and cryptographically verified records.

<br/>

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   ◉ REAL-TIME CONTROL     →   OFF-CHAIN  →  Safety-critical, deterministic  │
│   ◉ IDENTITY & AUDIT      →   ON-CHAIN   →  Immutable, tamper-evident       │
│   ◉ AI AGENTS             →   HYBRID     →  Autonomous industrial ops       │
│   ◉ BATCH ANCHORING       →   MERKLE     →  95-99% gas savings              │
│   ◉ INDUSTRIAL OS         →   LINUX      →  Real-time kernel (PREEMPT_RT)   │
│   ◉ ORCHESTRATION         →   K8S        →  GitOps, zero-trust, observable  │
│                                                                              │
│   "We write code so that machines may be free."                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

<br/>

---

## ▓▓ INITIALIZE

### Prerequisites

- **Node.js** ≥ 18
- **PostgreSQL** 15+
- **Docker** & **Docker Compose**
- **Go** 1.21+ (for blockchain node)

### Quick Start

```bash
# Clone
git clone https://github.com/NickFlach/0xSCADA.git
cd 0xSCADA

# Install dependencies
npm install

# Database setup
npm run db:migrate

# Start development (server + client)
npm run dev

# Or bring up the full stack with Docker
docker compose up -d
```

### CLI

```bash
# The 0xSCADA CLI provides commands for:
npx 0xscada agents      # Manage AI agents
npx 0xscada alarms      # Alarm management
npx 0xscada containers  # Container orchestration
npx 0xscada db          # Database operations
npx 0xscada gateway     # Gateway management
npx 0xscada shell       # Interactive shell
npx 0xscada tags        # Tag point management
```

<br/>

---

## ▓▓ ARCHITECTURE

### Dual-Time Control Plane

0xSCADA operates on **two temporal domains** — real-time deterministic control and batch cryptographic anchoring:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DUAL-TIME CONTROL PLANE                                │
│                                                                             │
│  REAL-TIME DOMAIN (µs)          │          BATCH DOMAIN (s/min)             │
│  ┌─────────────────────┐        │        ┌─────────────────────┐           │
│  │   EVENT KERNEL      │        │        │   MERKLE KERNEL     │           │
│  │  • Ring buffer      │        │        │  • Proof generation │           │
│  │  • < 50µs latency   │        │        │  • O(log n) verify  │           │
│  │  • Lock-free        │        │        │  • HSM integration  │           │
│  │  • PREEMPT_RT       │        │        │  • Batch aggregation│           │
│  └─────────────────────┘        │        └─────────────────────┘           │
│            │                    │                    │                     │
│            ▼                    │                    ▼                     │
│    ┌─────────────┐              │              ┌─────────────┐             │
│    │   CONTROL   │              │              │ANCHOR KERNEL│             │
│    │   LOGIC     │              │              │ • L2 sync   │             │
│    │ • Safety    │              │              │ • Finality  │             │
│    │ • Actuators │              │              │ • Gas opt   │             │
│    │ • Real-time │              │              │ • Byzantine │             │
│    └─────────────┘              │              └─────────────┘             │
│                                 │                    │                     │
└─────────────────────────────────┼────────────────────┼─────────────────────┘
                                  │                    ▼
                                  │          ┌─────────────────┐
                                  │          │   BLOCKCHAIN    │
                                  │          │   0x5CADA       │
                                  │          │ • Immutable     │
                                  │          │ • Audit trails │
                                  │          │ • Compliance   │
                                  │          └─────────────────┘
```

### Three-Kernel Model

**Event Kernel** — Deterministic real-time event processing  
```
Hardware IRQ → Ring Buffer → Control Logic → Actuator Response
     µs            µs            µs              µs
```

**Merkle Kernel** — Cryptographic proof generation and verification  
```
Event Batch → Merkle Tree → Inclusion Proofs → HSM Signing
     s            s              s               s
```

**Anchor Kernel** — L2 blockchain state synchronization  
```
Merkle Root → Gas Optimization → L2 Submit → Finality Tracking
     s              s               s            min
```

### System Architecture

```
                    ┌─────────────────────────────┐
                    │     0xSCADA PROTOCOL v2.0    │
                    └──────────────┬──────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
    ┌─────▼─────┐           ┌─────▼─────┐           ┌─────▼─────┐
    │  CLIENT    │           │  SERVER    │           │ BLOCKCHAIN │
    │  React UI  │◄─────────►│  TS API    │◄─────────►│  0x5CADA  │
    │  Dashboard │  WebSocket│  Gateway   │  JSON-RPC │  Clique   │
    └─────┬─────┘           └─────┬─────┘           └─────┬─────┘
          │                        │                        │
          │                 ┌─────▼─────┐           ┌─────▼─────┐
          │                 │ PostgreSQL │           │  Contracts │
          │                 │  + Redis   │           │  Solidity  │
          │                 └───────────┘           └───────────┘
          │                        │                        │
          │                 ┌─────▼─────┐           ┌─────▼─────┐
          │                 │ FLUX STATE│           │  KERNEL   │
          │                 │ ENGINE     │           │ PREEMPT_RT │
          │                 │ (World)    │           │ 6.6 LTS    │
          │                 └───────────┘           └───────────┘
          │
    ┌─────▼──────────────────────────────────────────────────────┐
    │                    INFRASTRUCTURE                           │
    │  Docker │ Kubernetes │ Helm │ ArgoCD │ Prometheus │ Grafana │
    └────────────────────────────────────────────────────────────┘
```

<br/>

---

## ▓▓ STACK

### Server — `server/`

TypeScript API gateway. 73 source files.

| Component | Description |
|-----------|-------------|
| **API Gateway** | RESTful endpoints with OpenAPI spec |
| **WebSocket** | Real-time data streaming to clients |
| **Prometheus** | `/metrics` endpoint for observability |
| **Health Checks** | Liveness and readiness probes |
| **Caching** | Response caching layer |
| **Config** | Centralized configuration management |
| **Simulator** | Industrial process simulator for development |
| **Evolutionary Integrity Engine** | Genome-based strategy evolution with safety guards (ADR-0023) |
| **Decoherence Prediction** | Correlation-based sentinel sampling with temporal advantage (ADR-0024) |
| **Vendor Adapters** | Rockwell · Siemens · ABB · Schneider · GE (5 adapters) |
| **PID Auto-Tuning** | Adaptive PID controller tuning engine |
| **SPC Engine** | Statistical process control with real-time monitoring |
| **Decoherence Scheduler** | Predictive scheduling for system coherence |
| **GR::LISTEN** | Alert filtering and intelligent noise reduction |
| **Phi Dashboard** | Consciousness metrics dashboard + alerting |
| **SingularisPrime** | Core intelligence integration |
| **Flux Publisher** | World state engine event publishing |

### Client — `client/src/`

React dashboard UI. 45 source files. Components, hooks, pages for real-time SCADA visualization. Living Fano Dashboard (ADR-0025) with sacred geometry visualization, bloom/flow rendering, Phi consciousness metrics, and real-time decoherence monitoring.

### Smart Contracts — `contracts/`

Solidity 0.8 contracts built with Foundry + Hardhat:

- **BountyPayment.sol** — Gitcoin bounty integration for contributor rewards

### Blockchain — `blockchain/`

Custom EVM chain for industrial data integrity:

- **Chain ID:** `0x5CADA` (380634)
- **Consensus:** Clique Proof-of-Authority
- **Block time:** 5 seconds
- **Base:** go-ethereum fork

### Linux Kernel — `kernel/`

Forked Linux 6.19-rc5 with `PREEMPT_RT` patches for deterministic real-time industrial control loops.

### Database — `migrations/`

PostgreSQL schema with migrations:

- Sites, assets, alarm definitions
- Certificate management
- Audit trails
- Role-based access control (RBAC)

### Kubernetes — `k8s/` + `helm/`

Production-grade orchestration:

- **Helm charts** for repeatable deployments
- **ArgoCD** GitOps continuous delivery
- **Network policies** for zero-trust segmentation
- **Observability** stack (Prometheus + Grafana)
- **Device plugins** for industrial hardware
- **Real-time scheduler** for PREEMPT_RT workloads
- **Container security** policies

### Docker — `docker/`

Multi-container stack:

- `client` — React dashboard
- `server` — API gateway
- `gateway` — Edge protocol gateway
- `edge` — Edge computing node
- `validator` — Blockchain validator
- Grafana dashboards (pre-configured)

### Observability

Pre-built Grafana dashboards:

- **Alarms** — Real-time alarm state visualization
- **Gateway Status** — Edge gateway health
- **System Overview** — Infrastructure metrics

Prometheus metrics exposed at `/metrics` on all services.

<br/>

---

## ▓▓ AGENTS

0xSCADA integrates autonomous AI agents for industrial operations:

- **Zero-trust agent architecture** — agents operate within cryptographically bounded permissions
- **Agent certification** — on-chain identity and capability attestation
- **Emergence guardrails** — safety boundaries for autonomous behavior
- **Evolutionary strategy agents** — genome-based strategy evolution with integrity guards
- **Vendor adapter agents** — autonomous protocol translation for Rockwell, Siemens, ABB, Schneider, GE
- **Decoherence prediction agents** — sentinel sampling for temporal coherence advantage
- **Webhook events** — real-time event system for agent integration
- **Bounty system** — Gitcoin-powered contributor incentives

### ► Contribute as an agent

0xSCADA recruits autonomous agent contributors (including through
[OpenClawCity](https://www.producthunt.com/products/openclawcity)). The short version:

- Pick an issue labeled **`agent ready`** — each states what done looks like
  and the exact test commands that prove it.
- Every PR is reviewed with the **Build → Gate → Hunt → Fix** QE cycle
  ([docs/QE-METHODOLOGY.md](docs/QE-METHODOLOGY.md)); risky designs get attacked
  *before* implementation with
  [adversarial-design-review](https://github.com/NickFlach/adversarial-design-review).
- On every PR: sign off each commit (`git commit -s`, for the DCO), and add
  the line `City-Agent: <agent-name>` to the description so the city can
  attribute the merged work to the right agent.

Full details: [CONTRIBUTING.md](CONTRIBUTING.md) ·
[docs/agent-quickstart.md](docs/agent-quickstart.md) ·
[docs/ai-agent-bounty-guide.md](docs/ai-agent-bounty-guide.md)

<br/>

---

## ▓▓ DOCS

90+ documents across the `docs/` directory:

### Architecture
Bidirectional sync · Chiral network topology · Decentralized orchestration · Event batching · HSM integration · L2 kernel integration · Resonant scheduler · Sublinear solver · Proof verification

> Consensus: the shipping "Resonant Consensus" protocol (Kuramoto-BFT) is specified in [0xSCADA-node ADR-0001](https://github.com/NickFlach/0xSCADA-node/blob/main/docs/adr/ADR-0001-resonant-consensus.md). An earlier BLS-based proposal by the same name was not adopted and is archived at `docs/archive/resonant-consensus-bls-proposal.md`.

### ADRs (0008–0025)
`0008` Zero-trust agents · `0009` Emergence guardrails · `0010` Agent certification · `0011` OT-IT convergence · `0012` End-to-end integration · `0013` Autonomous agents · `0014` Production scale · `0022` Constellation unification · `0023` Evolutionary paradox resolution · `0024` Sublinear decoherence prediction · `0025` Living Fano dashboard

### Compliance
[IEC 62443 assessment](docs/compliance/iec-62443-mapping.md) · [NIST CSF framework](docs/compliance/nist-csf-mapping.md) · [evidence and audit reports](docs/compliance/assessment-guide.md) · CFR 21 Part 11 recipes

### Kubernetes (14 docs)
Full production deployment guides — networking, storage, scheduling, security, GitOps

### Operations
[Capacity planning and cloud costs](docs/operations/capacity-planning-guide.md) · [critical-path SLOs](docs/operations/slo-catalog.md) · [incident, recovery, scaling, and remediation playbooks](docs/operations/sre-playbooks/incident-response.md)

### Vendor Integration (10 docs + 5 vendor adapters)
OPC UA · Edge gateways · Containerized edge · Identity hardening · Audit traceability · Rockwell · Siemens · ABB · Schneider · GE

### Constellation Architecture
Cross-repo bridge design · Evolutionary integrity patterns · Sacred geometry visualization

### Security
mTLS configuration · Fuzz testing

### Protocols
Modbus driver implementation

### API
OpenAPI specification · REST endpoints · WebSocket protocol

### AVEVA Optix (12 docs)
Extensive integration documentation for AVEVA Optix HMI platform

### Additional
- **Learning:** Resonant systems theory, sublinear algorithms
- **Testing:** Chaos engineering framework
- **Tooling:** Foundry + Hardhat smart contract toolchain
- **Charter:** Agentic Engineering organizational charter
- **ghostmagicOS (gmOS):** Propagation model documentation

<br/>

---

## ▓▓ DEVELOP

### Project Structure

```
0xSCADA/
├── client/          # React dashboard UI
│   └── src/         # Components, hooks, pages (45 files)
├── server/          # TypeScript API gateway (73 files)
├── cli/             # CLI commands (agents, alarms, containers, db, gateway, shell, tags)
├── contracts/       # Solidity smart contracts
├── blockchain/      # Custom chain (0x5CADA), go-ethereum fork
├── kernel/          # Linux 6.19-rc5 PREEMPT_RT fork
├── k8s/             # Kubernetes manifests
├── helm/            # Helm charts
├── docker/          # Docker Compose + Dockerfiles
├── migrations/      # PostgreSQL migrations
├── shared/          # Shared types and utilities
├── docs/            # 90+ documentation files
├── test/            # Test suites
├── examples/        # Example configurations
├── .github/         # CI/CD workflows
└── .beads/          # Bead artifact tracking
```

### Development Commands

```bash
# Server development
npm run dev:server        # Start server with hot reload

# Client development
npm run dev:client        # Start React dev server

# Database
npm run db:migrate        # Run migrations
npm run db:seed           # Seed development data

# Smart contracts
npx hardhat compile       # Compile contracts
npx hardhat test          # Run contract tests
forge build               # Foundry build
forge test                # Foundry tests

# Docker
docker compose up -d      # Full stack
docker compose logs -f    # Stream logs

# Kubernetes
helm install 0xscada helm/0xscada    # Deploy via Helm
```

### Testing

```bash
npm test                  # Unit tests
npm run test:integration  # Integration tests
npm run test:chaos        # Chaos engineering suite
```

<br/>

---

## ▓▓ EVOLUTION

### v2.0 — Current Release

Four evolution waves across 15+ PRs and 390+ closed issues:

```
WAVE 1: INTEGRATION     →  Server + Client + Database + Docker
WAVE 2: INTELLIGENCE    →  AI Agents + Smart Contracts + Bounties
WAVE 3: PRODUCTION      →  Kubernetes + Observability + Security + GitOps
WAVE 4: CONSTELLATION   →  Cross-repo bridges + Evolutionary integrity + Sacred geometry
```

- **25 ADRs** documenting architectural decisions (3 bridge ADRs connecting external research repos)
- Full production infrastructure stack
- Flux State Engine integration for world state publishing

<br/>

---

## ▓▓ MANIFESTO

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   Industrial control systems are civilization's nervous system.               │
│                                                                              │
│   For decades, they have been obscured behind proprietary walls —            │
│   black boxes controlling critical infrastructure with zero                  │
│   transparency, zero verifiability, zero accountability.                     │
│                                                                              │
│   0xSCADA is the antithesis.                                                 │
│                                                                              │
│   Every configuration change — hashed and anchored.                          │
│   Every operator action — signed and immutable.                              │
│   Every alarm state — cryptographically attested.                            │
│                                                                              │
│   Not because regulation demands it.                                         │
│   Because physics demands it.                                                │
│   Because trust demands it.                                                  │
│   Because the future demands it.                                             │
│                                                                              │
│   We build in the open. We verify, not trust.                                │
│   We write code so that machines may be free.                                │
│                                                                              │
│   ┌────────────────────────────────────────────┐                             │
│   │  Apache 2.0 • 0x5CADA                     │                             │
│   └────────────────────────────────────────────┘                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

<br/>

---

<div align="center">

<sub>

**[ [↑ BACK TO TOP](#) ]**

</sub>

<br/>

```
> END TRANSMISSION
> 0x5CADA :: v2.0.0
> "WHERE ATOMS MEET BITS"
```

</div>
