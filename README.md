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

---

<sub>

**[ [INITIALIZE](#-initialize) • [ARCHITECTURE](#-architecture) • [PROTOCOL](#-protocol) • [CODEGEN](#-codegen) • [AGENTS](#-agents) • [MANIFESTO](#-manifesto) • [ROADMAP](#-roadmap) ]**

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

**0xSCADA** exists at the convergence of two futures: the industrial substrate that powers civilization, and the cryptographic protocols that will free it.

This is not a product. This is a **protocol**.

A system where the machines that pump your water, refine your fuel, and generate your electricity are governed not by obscured corporate databases—but by transparent, immutable, and cryptographically verified records.

<br/>

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   ◉ REAL-TIME CONTROL     →   OFF-CHAIN  →  Safety-critical, deterministic  │
│   ◉ IDENTITY & AUDIT      →   ON-CHAIN   →  Immutable, tamper-evident       │
│   ◉ CODE GENERATION       →   HYBRID     →  Vendor-agnostic, reproducible   │
│   ◉ BATCH ANCHORING       →   MERKLE     →  95-99% gas savings              │
│   ◉ INDUSTRIAL OS         →   LINUX      →  Real-time kernel (PREEMPT_RT)   │
│                                                                              │
│   "We write code so that machines may be free."                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

<br/>

---

## ▓▓ WHAT'S NEW

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                         JANUARY 2026 // MAJOR UPDATES                        ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   🔗 CUSTOM BLOCKCHAIN FORK                                                  ║
║      ▸ Chain ID: 380634 (0x5CADA) - Our own industrial blockchain            ║
║      ▸ Clique PoA consensus with 5-second block time                         ║
║      ▸ Forked go-ethereum in geth-fork/ directory                            ║
║      ▸ Pre-funded accounts for development                                   ║
║                                                                              ║
║   🐧 LINUX KERNEL FORK                                                       ║
║      ▸ Kernel 6.19.0-rc5 from Linus Torvalds' mainline                       ║
║      ▸ Foundation for real-time (PREEMPT_RT) industrial control              ║
║      ▸ Industrial I/O (IIO) subsystem for sensors/actuators                  ║
║      ▸ Cross-compilation: ARM64, RISC-V, x86_64                              ║
║                                                                              ║
║   📦 BATCH ANCHORING SYSTEM                                                  ║
║      ▸ Merkle tree batching for high-volume event anchoring                  ║
║      ▸ 95-99% gas savings vs individual event anchoring                      ║
║      ▸ On-chain Merkle proof verification                                    ║
║      ▸ Configurable batch cadence (size/time triggers)                       ║
║                                                                              ║
║   🌊 EIP-4844 BLOB SUPPORT (Prototype)                                       ║
║      ▸ Ultra-high-throughput data availability                               ║
║      ▸ KZG commitment preparation                                            ║
║      ▸ Cost estimation API                                                   ║
║                                                                              ║
║   🪜 LADDER LOGIC AGENT                                                      ║
║      ▸ AI-driven ladder logic for Rockwell Studio 5000                       ║
║      ▸ All standard instructions (XIC, XIO, OTE, TON, CTU, etc.)             ║
║      ▸ Batch rung generation with CSV substitution                           ║
║      ▸ RungBuilder fluent API                                                ║
║                                                                              ║
║   🤖 AGENTIC GOVERNANCE                                                      ║
║      ▸ Ops Agent: Monitoring and operations                                  ║
║      ▸ ChangeControl Agent: Approval workflows                               ║
║      ▸ Compliance Agent: Regulatory verification                             ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

<br/>

---

## ▓▓ INITIALIZE

```bash
# ═══════════════════════════════════════════════════════════════════
# BOOT SEQUENCE // 0xSCADA INDUSTRIAL CONTROL FABRIC v2.0.0
# ═══════════════════════════════════════════════════════════════════

# [01] CLONE THE PROTOCOL
git clone https://github.com/The-ESCO-Group/0xSCADA.git
cd 0xSCADA

# [02] INSTALL DEPENDENCIES
npm install

# [03] INITIALIZE DATABASE SCHEMA
npm run db:push

# [04] SEED VENDOR CONFIGURATIONS
curl -X POST http://localhost:5000/api/blueprints/seed

# [05] ACTIVATE
npm run dev

# ═══════════════════════════════════════════════════════════════════
# SYSTEM ONLINE // ACCESS POINTS
# ═══════════════════════════════════════════════════════════════════
# 
# ▸ DASHBOARD     http://localhost:5000
# ▸ SITE REGISTRY http://localhost:5000/sites  
# ▸ AUDIT LOGS    http://localhost:5000/events
# ▸ BLUEPRINTS    http://localhost:5000/blueprints
# ▸ CODEGEN       http://localhost:5000/codegen
# ▸ AGENTS        http://localhost:5000/agents
# ▸ API DOCS      http://localhost:5000/api/docs        (Swagger UI)
# ▸ API DOCS      http://localhost:5000/api/docs/redoc  (ReDoc)
#
```

<br/>

### PREREQUISITES

| Component | Requirement | Purpose |
|-----------|-------------|---------|
| `Node.js` | **18+** | Runtime environment |
| `PostgreSQL` | **15+** | Event & asset persistence |
| `Go` | **1.21+** | Custom geth blockchain (optional) |
| `Hardhat` | _included_ | Smart contract development |
| `Linux Headers` | _optional_ | Kernel module development |

<br/>

### ADVANCED SETUP

```bash
# ═══════════════════════════════════════════════════════════════════
# OPTIONAL: BUILD CUSTOM BLOCKCHAIN (0x5CADA CHAIN)
# ═══════════════════════════════════════════════════════════════════

# Build geth from our fork
cd geth-fork && make geth

# Initialize the chain
./blockchain/init-chain.sh

# Start the node (PoA consensus, 5s blocks)
./blockchain/start-node.sh

# ═══════════════════════════════════════════════════════════════════
# OPTIONAL: BUILD INDUSTRIAL LINUX KERNEL
# ═══════════════════════════════════════════════════════════════════

# Configure kernel
./kernel/configure.sh menuconfig

# Build (requires cross-compilation toolchain for ARM64/RISC-V)
./kernel/build.sh

# View kernel info
./kernel/info.sh
```

<br/>

---

## ▓▓ CLI

The `0xscada` CLI provides a unified command-line interface for development and operations.

### INSTALLATION

```bash
# Install from repository
cd cli
npm install
npm link  # Makes '0xscada' available globally
```

### QUICK START

```bash
# Check system health
0xscada status

# List sites and assets
0xscada sites list
0xscada assets list

# View recent events
0xscada events list --limit 10

# Trigger batch anchoring
0xscada events anchor

# Start development environment
0xscada dev start
```

### CORE COMMANDS

| Command | Description |
|---------|-------------|
| `0xscada status` | Show system health (DB, blockchain, services) |
| `0xscada sites list` | List registered sites |
| `0xscada sites get <id>` | Get site details |
| `0xscada assets list` | List assets |
| `0xscada events list` | List recent events |
| `0xscada events anchor` | Manually trigger batch anchoring |
| `0xscada blockchain info` | Chain status, latest block, gas prices |
| `0xscada dev start` | Start local dev environment |
| `0xscada dev seed` | Seed database with test data |
| `0xscada config show` | Display current configuration |
| `0xscada config set <k> <v>` | Update config |

### JSON OUTPUT

All commands support `--json` for scripting:

```bash
# Get sites as JSON
0xscada sites list --json | jq '.[0].name'

# Check health in scripts
if 0xscada status --json | jq -e '.health.status == "healthy"' > /dev/null; then
  echo "System healthy"
fi
```

Full CLI documentation: [`cli/README.md`](./cli/README.md)

<br/>

---

## ▓▓ ARCHITECTURE

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   ██████████████████████████████████████████████████████████████████████     ║
║   █                   0xSCADA CONTROL FABRIC v2.0.0                    █     ║
║   ██████████████████████████████████████████████████████████████████████     ║
║                                                                              ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              ║
║   │   ░░ REACT ░░   │  │  ░░ EXPRESS ░░  │  │  ░░ AGENTS ░░   │              ║
║   │   Dashboard     │◄─┤   API Gateway   ├─►│   Ops/Change/   │              ║
║   │   Operations    │  │   REST + WS     │  │   Compliance    │              ║
║   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              ║
║            │                    │                    │                       ║
║   ┌────────┴────────┐  ┌────────┴────────┐  ┌────────┴────────┐              ║
║   │ ░░ BLUEPRINTS ░░│  │░░ BATCH ANCHOR ░│  │  ░░ CODEGEN ░░  │              ║
║   │   ISA-88 Model  │  │   Merkle Trees  │  │   Multi-Vendor  │              ║
║   │   Phase Types   │  │   EIP-4844 Blob │  │   SCL/L5X/LAD   │              ║
║   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              ║
║            │                    │                    │                       ║
║            └────────────────────┼────────────────────┘                       ║
║                                 │                                            ║
║         ┌───────────────────────┼───────────────────────┐                    ║
║         │                       │                       │                    ║
║         ▼                       ▼                       ▼                    ║
║   ┌───────────┐           ┌───────────┐           ┌───────────┐              ║
║   │░░░░░░░░░░░│           │░░░░░░░░░░░│           │░░░░░░░░░░░│              ║
║   │ POSTGRES  │           │ 0x5CADA   │           │ LINUX     │              ║
║   │           │           │ CHAIN     │           │ KERNEL    │              ║
║   │ ▸ Sites   │           │           │           │           │              ║
║   │ ▸ Assets  │           │ ▸ Geth PoA│           │ ▸ 6.19-rc5│              ║
║   │ ▸ Events  │           │ ▸ 5s Block│           │ ▸ PREEMPT │              ║
║   │ ▸ Batches │           │ ▸ Registry│           │ ▸ IIO     │              ║
║   └───────────┘           └───────────┘           └───────────┘              ║
║                                                                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                           FIELD LAYER // PLCs & RTUs                         ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       ║
║   │▓▓▓▓▓▓▓▓▓▓│  │▓▓▓▓▓▓▓▓▓▓│  │▓▓▓▓▓▓▓▓▓▓│  │▓▓▓▓▓▓▓▓▓▓│  │▓▓▓▓▓▓▓▓▓▓│       ║
║   │ SIEMENS  │  │ ROCKWELL │  │   ABB    │  │ EMERSON  │  │ SCHNEIDER│       ║
║   │ S7-1500  │  │CtrlLogix │  │  AC500   │  │ DeltaV   │  │ Modicon  │       ║
║   └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘       ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

<br/>

### DATA FLOW

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  [FIELD]          [BATCH]            [MERKLE]           [CHAIN]             │
│                                                                             │
│   PLC/RTU  ─────►  Queue   ─────►   Build Tree  ─────►  Anchor   ─────►  ∞  │
│   Event           Events           Merkle Root          Root TX             │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  INDIVIDUAL: 1 event = 1 tx = ~50,000 gas                           │   │
│   │  BATCHED:    N events = 1 tx = ~30,000 gas  (95-99% savings)        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   "What happens in the field, stays on the chain."                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

<br/>

---

## ▓▓ API DOCUMENTATION

> **📖 Interactive API Documentation**
> 
> Full OpenAPI 3.0 specification with interactive UI:
> - **Swagger UI**: [http://localhost:5000/api/docs](http://localhost:5000/api/docs)
> - **ReDoc**: [http://localhost:5000/api/docs/redoc](http://localhost:5000/api/docs/redoc)
> - **OpenAPI Spec**: [http://localhost:5000/api/docs/openapi.yaml](http://localhost:5000/api/docs/openapi.yaml)
>
> The API documentation covers all 100+ endpoints including:
> - Sites, Assets, Events, Maintenance
> - Blueprints Engine (ISA-88 Control Modules, Phases, Units)
> - Code Generation (Siemens SCL, Rockwell L5X, Ladder Logic)
> - Agent Framework (Ops, ChangeControl, Compliance)
> - Asset Administration Shell (IEC 63278 Digital Twin)
> - Batch Anchoring & Merkle Proofs
> - Real-time Tag Subscriptions

<br/>

---

## ▓▓ PROTOCOL

### CORE ENDPOINTS

```bash
# ═══════════════════════════════════════════════════════════════════
# SITES & ASSETS
# ═══════════════════════════════════════════════════════════════════
GET    /api/sites                    # Query all registered sites
POST   /api/sites                    # Register new industrial site
GET    /api/assets                   # Query all registered assets
GET    /api/assets/site/:siteId      # Assets by site
POST   /api/assets                   # Register new asset

# ═══════════════════════════════════════════════════════════════════
# EVENTS & ANCHORING
# ═══════════════════════════════════════════════════════════════════
GET    /api/events?limit=100         # Query recent events
POST   /api/events                   # Record + auto-anchor event
GET    /api/maintenance              # Maintenance records
POST   /api/maintenance              # Record maintenance

# ═══════════════════════════════════════════════════════════════════
# BLOCKCHAIN STATUS
# ═══════════════════════════════════════════════════════════════════
GET    /api/blockchain/status        # Chain connectivity status
```

<br/>

### BATCH ANCHORING (High-Volume)

```bash
# ═══════════════════════════════════════════════════════════════════
# MERKLE BATCH ANCHORING // 95-99% GAS SAVINGS
# ═══════════════════════════════════════════════════════════════════
GET    /api/batch/stats              # Batch service stats & config
GET    /api/batch/history            # Recent batch anchoring history
GET    /api/batch/pending            # Pending events in queue
POST   /api/batch/flush              # Force immediate batch flush
PUT    /api/batch/config             # Update batch config (size, age, enabled)
GET    /api/batch/:batchId/proof/:eventId   # Get Merkle proof for event

# ═══════════════════════════════════════════════════════════════════
# EIP-4844 BLOB ANCHORING // ULTRA-HIGH-THROUGHPUT
# ═══════════════════════════════════════════════════════════════════
GET    /api/batch/blob/config        # Get blob configuration
PUT    /api/batch/blob/config        # Update blob configuration
POST   /api/batch/blob/estimate      # Estimate blob vs calldata costs
```

<br/>

### BLUEPRINTS ENGINE

```bash
# ═══════════════════════════════════════════════════════════════════
# ISA-88 BATCH CONTROL
# ═══════════════════════════════════════════════════════════════════
GET    /api/blueprints/cm-types      # Control Module Types
GET    /api/blueprints/cm-instances  # Control Module Instances
GET    /api/blueprints/unit-types    # Unit Types
GET    /api/blueprints/unit-instances # Unit Instances
GET    /api/blueprints/phase-types   # Phase Types
GET    /api/blueprints/phase-instances # Phase Instances
GET    /api/blueprints/design-specs  # Design Specifications
POST   /api/blueprints/import        # Import blueprint package
GET    /api/blueprints/summary       # Statistics

# ═══════════════════════════════════════════════════════════════════
# VENDORS & TEMPLATES
# ═══════════════════════════════════════════════════════════════════
GET    /api/vendors                  # List vendors
GET    /api/templates                # List templates
GET    /api/templates/vendor/:id     # Templates by vendor
GET    /api/data-types/vendor/:id    # Data type mappings
GET    /api/controllers              # PLC/DCS definitions
```

<br/>

---

## ▓▓ CODEGEN

> *"The machine does not care who writes its code. Only that the code is correct."*

<br/>

### SUPPORTED PLATFORMS

| Vendor | Platforms | Languages | Export Formats |
|--------|-----------|-----------|----------------|
| **SIEMENS** | TIA Portal, STEP 7 | `SCL` `LAD` `FBD` | SCL Source, TIA XML |
| **ROCKWELL** | Studio 5000, RSLogix | `ST` `Ladder` `AOI` | L5X, AOI Definition |
| **ABB** | Automation Builder | `ST` `LAD` `FBD` | IEC 61131-3 |
| **EMERSON** | DeltaV, Ovation | `ST` `FBD` `SFC` | Native Export |
| **SCHNEIDER** | EcoStruxure | `ST` `LAD` `FBD` | Native Export |

<br/>

### GENERATION ENDPOINTS

```bash
# ═══════════════════════════════════════════════════════════════════
# STRUCTURED TEXT & SCL // DETERMINISTIC OUTPUT
# ═══════════════════════════════════════════════════════════════════
POST   /api/generate/control-module/:id   # Generate CM code
POST   /api/generate/phase/:id            # Generate phase code
GET    /api/generated-code                # Audit trail
POST   /api/generated-code/:id/anchor     # Anchor to blockchain

# ═══════════════════════════════════════════════════════════════════
# LADDER LOGIC AGENT // ROCKWELL STUDIO 5000
# ═══════════════════════════════════════════════════════════════════
GET    /api/ladder-logic/instructions     # Instruction library
POST   /api/generate/ladder-logic/control-module/:id  # Generate ladder CM
POST   /api/generate/ladder-logic/phase/:id           # Generate ladder phase
POST   /api/ladder-logic/batch            # Batch rung generation (CSV)
POST   /api/ladder-logic/ai-context/:id   # AI prompt context for external AI
```

<br/>

### EXAMPLE: SIEMENS SCL OUTPUT

```pascal
// ═══════════════════════════════════════════════════════════════════
// GENERATED BY 0xSCADA BLUEPRINTS ENGINE
// HASH: 0x7a8b9c...
// ANCHORED: Block #14,892,037
// ═══════════════════════════════════════════════════════════════════

FUNCTION_BLOCK "FB_PIDController"
VAR_INPUT
    Enable      : BOOL;
    Setpoint    : REAL;
    ProcessVar  : REAL;
END_VAR

VAR_OUTPUT
    Output      : REAL;
    Status      : WORD;
END_VAR

VAR
    _Kp         : REAL := 1.0;
    _Ki         : REAL := 0.1;
    _Kd         : REAL := 0.05;
    _Integral   : REAL;
    _LastError  : REAL;
END_VAR

// ... deterministic control logic
// ... verified by cryptographic hash
// ... immutable audit trail

END_FUNCTION_BLOCK
```

<br/>

---

## ▓▓ AGENTS

> *"Human-in-the-loop for critical changes. Autonomous for everything else."*

<br/>

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENTIC GOVERNANCE LAYER                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│   │   OPS AGENT  │    │ CHANGECONTROL│    │  COMPLIANCE  │                  │
│   │              │    │    AGENT     │    │    AGENT     │                  │
│   │ ▸ Monitoring │    │ ▸ Approvals  │    │ ▸ Regulatory │                  │
│   │ ▸ Alerting   │    │ ▸ Workflows  │    │ ▸ Audit      │                  │
│   │ ▸ Triage     │    │ ▸ Rollback   │    │ ▸ Reporting  │                  │
│   └──────────────┘    └──────────────┘    └──────────────┘                  │
│                                                                             │
│   "Agentic governance: machines propose, humans approve, chains record."    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

<br/>

---

## ▓▓ ENVIRONMENT

```bash
# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION // ENVIRONMENT VARIABLES
# ═══════════════════════════════════════════════════════════════════

# DATABASE
DATABASE_URL="postgresql://..."          # PostgreSQL connection

# BLOCKCHAIN (optional - defaults to localhost:8545)
BLOCKCHAIN_RPC_URL="http://127.0.0.1:8545"   # Ethereum/Geth RPC
BLOCKCHAIN_PRIVATE_KEY="0x..."               # Signing key

# SIMULATOR
SIMULATOR_ENABLED="true"                 # Field event simulator
SIMULATOR_INTERVAL_MS="10000"            # Event frequency

# BATCH ANCHORING
BATCH_MAX_SIZE="100"                     # Events per batch
BATCH_MAX_AGE_MS="60000"                 # Max wait time before flush
BATCH_ENABLED="true"                     # Enable Merkle batching
```

<br/>

### ENABLE CUSTOM BLOCKCHAIN (0x5CADA)

```bash
# ═══════════════════════════════════════════════════════════════════
# OPTION A: Use our custom PoA chain (recommended for production)
# ═══════════════════════════════════════════════════════════════════

# Build geth from fork
cd geth-fork && make geth

# Initialize and start
./blockchain/init-chain.sh
./blockchain/start-node.sh

# Chain ID: 380634 (0x5CADA)
# Block Time: 5 seconds
# Consensus: Clique PoA

# ═══════════════════════════════════════════════════════════════════
# OPTION B: Use Hardhat local network (for development)
# ═══════════════════════════════════════════════════════════════════

# Terminal 1: Start local EVM
npx hardhat node

# Terminal 2: Deploy IndustrialRegistry contract
npx hardhat run scripts/deploy.ts --network localhost

# Terminal 3: Configure and restart
export BLOCKCHAIN_RPC_URL=http://127.0.0.1:8545
export BLOCKCHAIN_PRIVATE_KEY=0xac0974bec...  # Hardhat test key
npm run dev
```

<br/>

---

## ▓▓ MANIFESTO

<br/>

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   WE BELIEVE:                                                                ║
║                                                                              ║
║   ▸ Industrial systems should be auditable by those who depend on them      ║
║   ▸ Cryptographic proof is superior to institutional trust                  ║
║   ▸ Control logic must remain deterministic and safety-critical             ║
║   ▸ Audit trails must be immutable and publicly verifiable                  ║
║   ▸ Code generation should be reproducible and vendor-agnostic              ║
║   ▸ The infrastructure of civilization deserves cryptographic guarantees    ║
║                                                                              ║
║   WE BUILD:                                                                  ║
║                                                                              ║
║   ▸ Open protocols, not proprietary silos                                   ║
║   ▸ Transparent systems, not obscured databases                             ║
║   ▸ Cryptographic proof, not paper certifications                           ║
║   ▸ Decentralized identity, not corporate gatekeepers                       ║
║   ▸ Quantum-resistant infrastructure, not legacy vulnerabilities            ║
║                                                                              ║
║   "Cypherpunks write code. We know that someone has to write software       ║
║    to defend privacy, and since we can't get privacy unless we all do,      ║
║    we're going to write it."                                                 ║
║                                                                              ║
║                                              — Eric Hughes, 1993             ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

<br/>

---

## ▓▓ SECURITY

| CONSIDERATION | IMPLEMENTATION |
|---------------|----------------|
| **Private Keys** | Environment variables only. Never committed. |
| **Input Validation** | All inputs validated via Zod schemas |
| **Access Control** | Role-based permissions (production) |
| **Rate Limiting** | API rate limits for public endpoints |
| **Audit Trail** | SHA-256 hashing + blockchain anchoring |
| **Batch Verification** | Merkle proofs for individual event verification |
| **Safety Isolation** | Control logic OFF-chain. Always. |
| **Quantum Roadmap** | Post-quantum cryptography planned (Phase 12) |

<br/>

---

## ▓▓ ROADMAP

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   [████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░]  60%      │
│                                                                             │
│   ✓ PHASE 1-4   Core platform, multi-vendor blueprints, code generation    │
│   ✓ PHASE 5     Batch anchoring, ladder logic agent, agentic governance    │
│   ◐ PHASE 6     Real-time PLC comms (OPC-UA, S7, EtherNet/IP, Modbus)      │
│   ○ PHASE 7     ISA-88 batch runtime engine, recipe management             │
│   ○ PHASE 8     HMI/SCADA visualization suite, P&ID renderer               │
│   ○ PHASE 9     OxSCADA Operating System (custom Linux, PREEMPT_RT)        │
│   ○ PHASE 10    Decentralized network, site federation, DIDs               │
│   ○ PHASE 11    AI & digital twins, predictive maintenance                 │
│   ○ PHASE 12    Quantum integration, post-quantum cryptography             │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   TARGET RELEASES:                                                          │
│                                                                             │
│   v2.1.0  Q1 2026   Real-time industrial communication                      │
│   v2.2.0  Q2 2026   ISA-88 batch runtime                                    │
│   v2.3.0  Q3 2026   HMI/SCADA visualization                                 │
│   v3.0.0  Q4 2026   OxSCADA operating system                                │
│   v3.1.0  Q1 2027   Decentralized network                                   │
│   v3.2.0  Q2 2027   AI & digital twins                                      │
│   v3.3.0  Q3 2027   Quantum integration                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

<br/>

---

## ▓▓ LEARNING TRACKS

> *"We don't just build software. We build engineers."*

<br/>

0xSCADA offers structured learning paths for contributors at all levels:

| Track | Focus | Skills |
|-------|-------|--------|
| **A: Frontend** | React, visualization, real-time UI | D3.js, WebGL, P&ID rendering |
| **B: Backend** | APIs, services, protocols | Express, Drizzle, Modbus/OPC-UA |
| **C: Blockchain** | Smart contracts, consensus | Solidity, ethers.js, PoA |
| **D: Systems** | Linux kernel, drivers | C, device drivers, PREEMPT_RT |
| **E: Automation** | PLC programming, ISA-88 | IEC 61131-3, batch control |
| **Q: Quality** | Testing, automation | Vitest, Playwright, mutation testing |
| **F: Quantum** | Post-quantum crypto | Lattice crypto, QAOA, Qiskit |

Each track has 4 levels with progressive challenges. See [docs/ROADMAP.md](docs/ROADMAP.md) for full details.

<br/>

---

## ▓▓ CONTRIBUTE

```bash
# Fork → Branch → Commit → Push → PR

git checkout -b feature/your-feature
git commit -m 'feat: add amazing feature'
git push origin feature/your-feature
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full protocol.

<br/>

### GOOD FIRST ISSUES

Look for issues tagged with:
- `👋 Good First Issue` - Perfect for newcomers
- `🌱 Beginner` - Foundation-level tasks
- `📚 Documentation` - Docs improvements

<br/>

---

## ▓▓ LICENSE

```
Apache License 2.0

Copyright 2024-2026 The ESCO Group

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

<br/>

---

<div align="center">

<br/>

```
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░                                                                             ░
░   BUILT WITH ◈ BY THE ESCO GROUP                                           ░
░                                                                             ░
░   "WHERE ATOMS MEET BITS. WHERE INDUSTRY MEETS CRYPTOGRAPHY."               ░
░                                                                             ░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

<br/>

[![GitHub](https://img.shields.io/badge/GITHUB-The--ESCO--Group-00FF9C?style=for-the-badge&labelColor=0D0D0D&logo=github&logoColor=00FF9C)](https://github.com/The-ESCO-Group)
[![Issues](https://img.shields.io/badge/ISSUES-Report-ff4081?style=for-the-badge&labelColor=0D0D0D&logo=github&logoColor=ff4081)](https://github.com/The-ESCO-Group/0xSCADA/issues)
[![Discussions](https://img.shields.io/badge/DISCUSSIONS-Join-c592ff?style=for-the-badge&labelColor=0D0D0D&logo=github&logoColor=c592ff)](https://github.com/The-ESCO-Group/0xSCADA/discussions)

<br/>

<sub>

**[ DECENTRALIZED • IMMUTABLE • TRUSTLESS • QUANTUM-READY ]**

</sub>

</div>
