# OxSCADA Roadmap: Decentralized Industrial Control System

> **Vision**: A fully decentralized public utility for industrial environments with a Linux-like OS, Ethereum-compatible chain, and vendor-agnostic HMI/PLC development suites.

## Current State: v2.0.0 (60% Complete)

| Layer | Status | Description |
|-------|--------|-------------|
| Core Platform | ✅ Complete | Sites, Assets, Events, Multi-vendor Blueprints |
| Blockchain | ✅ Complete | Custom PoA chain (0x5CADA), Merkle anchoring |
| Agents | ✅ Complete | Ops, ChangeControl, Compliance agents |
| Linux Fork | ✅ Started | Kernel 6.19-rc5 with PREEMPT_RT |
| HMI Suite | ◐ Partial | Dashboard exists, visual editor needed |
| PLC Comms | ○ Planned | Protocol drivers simulated only |

---

## 🎯 Roadmap Phases

### Phase 6: Real-Time Industrial Communication
**Milestone**: `v2.1.0-realtime`
**Duration**: ~8-12 weeks
**Learning Focus**: Industrial protocols, real-time systems

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| OPC-UA Driver | 6.1.x | Protocol buffers, async I/O, binary parsing |
| Modbus TCP Driver | 6.2.x | TCP/IP, polling, register mapping |
| S7 Protocol Driver | 6.3.x | Siemens RFC 1006, binary encoding |
| EtherNet/IP Driver | 6.4.x | CIP protocol, session management |
| Gateway Service | 6.5.x | Service architecture, health monitoring |

### Phase 7: ISA-88 Batch Runtime Engine
**Milestone**: `v2.2.0-batch`
**Duration**: ~10-14 weeks
**Learning Focus**: State machines, industrial standards, safety

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| State Machine Engine | 7.1.x | FSM patterns, transition guards |
| Recipe Management | 7.2.x | Parameter handling, versioning |
| Equipment Module Execution | 7.3.x | Coordination, resource locking |
| Phase Orchestration | 7.4.x | Concurrent execution, sequencing |
| Safety Interlock System | 7.5.x | Critical systems, fail-safe design |

### Phase 8: HMI/SCADA Visualization Suite
**Milestone**: `v2.3.0-hmi`
**Duration**: ~12-16 weeks
**Learning Focus**: Real-time graphics, WebGL, UX design

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| P&ID Diagram Renderer | 8.1.x | SVG, canvas, vector graphics |
| Real-Time Data Binding | 8.2.x | WebSocket, state synchronization |
| Alarm Management UI | 8.3.x | Priority systems, acknowledgment flows |
| Trend/Historical Charts | 8.4.x | Time-series, D3.js, aggregation |
| HMI Code Generator | 8.5.x | Template systems, auto-generation |

### Phase 9: OxSCADA Operating System
**Milestone**: `v3.0.0-os`
**Duration**: ~16-24 weeks
**Learning Focus**: Systems programming, kernel development, security

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| Kernel Hardening | 9.1.x | Linux security, PREEMPT_RT |
| Industrial I/O Subsystem | 9.2.x | Device drivers, kernel modules |
| Process Isolation | 9.3.x | Containers, namespaces, cgroups |
| Secure Boot Chain | 9.4.x | UEFI, TPM, measured boot |
| Package Management | 9.5.x | APT-like system, dependency resolution |
| Init System | 9.6.x | systemd alternatives, service management |

### Phase 10: Decentralized Network & Governance
**Milestone**: `v3.1.0-decentralized`
**Duration**: ~12-16 weeks
**Learning Focus**: Distributed systems, consensus, cryptography

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| Multi-Node Consensus | 10.1.x | PBFT, PoA enhancements |
| Site Federation | 10.2.x | Distributed registry, gossip protocols |
| Decentralized Identity | 10.3.x | DIDs, verifiable credentials |
| Cross-Site Event Sync | 10.4.x | CRDTs, eventual consistency |
| Public Validator Network | 10.5.x | Staking, slashing, governance |

### Phase 11: AI & Digital Twins
**Milestone**: `v3.2.0-ai`
**Duration**: ~12-16 weeks
**Learning Focus**: ML, simulation, predictive analytics

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| Process Simulation Engine | 11.1.x | Physics modeling, ODE solvers |
| AI-Assisted Code Generation | 11.2.x | LLM integration, prompt engineering |
| Anomaly Detection | 11.3.x | Time-series ML, threshold learning |
| Predictive Maintenance | 11.4.x | Failure prediction, RUL estimation |
| Digital Twin Visualization | 11.5.x | 3D rendering, WebGL, Three.js |

### Phase 12: Quantum Integration
**Milestone**: `v3.3.0-quantum`
**Duration**: ~14-20 weeks
**Learning Focus**: Post-quantum cryptography, quantum algorithms, hybrid computing

| Epic | Issues | Skills Learned |
|------|--------|----------------|
| Post-Quantum Cryptography | 12.1.x | Lattice-based crypto, CRYSTALS-Kyber, CRYSTALS-Dilithium |
| Quantum-Safe Blockchain | 12.2.x | Hash-based signatures, quantum-resistant consensus |
| Quantum Key Distribution | 12.3.x | QKD protocols, secure key exchange, BB84 concepts |
| Quantum Optimization | 12.4.x | QAOA, variational algorithms, process optimization |
| Hybrid Classical-Quantum | 12.5.x | Qiskit/Cirq integration, quantum simulators |
| Quantum-Ready Infrastructure | 12.6.x | Crypto agility, algorithm migration, future-proofing |

---

## 🎓 Learning Tracks for Contributors

### Track A: Frontend Engineering
**Entry Level**: JavaScript, React basics
**Exit Level**: Real-time industrial visualization expert

```
Level 1 (Issues: A1.x) - Foundation
├── React 19 fundamentals
├── TailwindCSS styling
├── Component architecture (shadcn/ui)
└── Project: Build a simple tag status card

Level 2 (Issues: A2.x) - State Management
├── TanStack Query for server state
├── WebSocket real-time updates
├── Optimistic UI patterns
└── Project: Event stream component

Level 3 (Issues: A3.x) - Visualization
├── SVG manipulation
├── Canvas/WebGL basics
├── D3.js charting
└── Project: Real-time trend chart

Level 4 (Issues: A4.x) - Industrial UX
├── P&ID diagram rendering
├── Alarm priority systems
├── Shift handoff workflows
└── Project: HMI screen builder
```

### Track B: Backend Engineering
**Entry Level**: TypeScript, Express basics
**Exit Level**: Industrial systems architect

```
Level 1 (Issues: B1.x) - Foundation
├── Express middleware
├── Drizzle ORM queries
├── REST API design
└── Project: New entity CRUD endpoint

Level 2 (Issues: B2.x) - Domain Logic
├── Event-driven architecture
├── Service layer patterns
├── Transaction management
└── Project: Event batching service

Level 3 (Issues: B3.x) - Industrial Protocols
├── Binary protocol parsing
├── Connection pooling
├── Store-and-forward patterns
└── Project: Modbus TCP driver

Level 4 (Issues: B4.x) - Distributed Systems
├── Consensus algorithms
├── Event sourcing
├── CQRS patterns
└── Project: Multi-site federation
```

### Track C: Blockchain Engineering
**Entry Level**: JavaScript, basic crypto concepts
**Exit Level**: Industrial blockchain architect

```
Level 1 (Issues: C1.x) - Foundation
├── Solidity basics
├── Hardhat development
├── ethers.js interactions
└── Project: Simple anchoring contract

Level 2 (Issues: C2.x) - Smart Contracts
├── Contract patterns (registry, upgrades)
├── Gas optimization
├── Event emission
└── Project: Multi-sig approval contract

Level 3 (Issues: C3.x) - Chain Operations
├── Clique PoA consensus
├── Genesis configuration
├── Node operations
└── Project: Testnet deployment

Level 4 (Issues: C4.x) - Advanced Crypto
├── Merkle trees & proofs
├── EIP-4844 blobs
├── Zero-knowledge basics
└── Project: Batch anchoring system
```

### Track D: Systems Engineering
**Entry Level**: Linux basics, C familiarity
**Exit Level**: Industrial OS developer

```
Level 1 (Issues: D1.x) - Foundation
├── Linux kernel basics
├── Kernel compilation
├── Module loading
└── Project: Hello world kernel module

Level 2 (Issues: D2.x) - Real-Time Systems
├── PREEMPT_RT patches
├── Scheduling policies
├── Latency measurement
└── Project: RT benchmark suite

Level 3 (Issues: D3.x) - Device Drivers
├── Industrial I/O (IIO)
├── Character devices
├── DMA and interrupts
└── Project: Industrial GPIO driver

Level 4 (Issues: D4.x) - Security
├── SELinux/AppArmor
├── Secure boot
├── TPM integration
└── Project: Measured boot chain
```

### Track E: Industrial Automation
**Entry Level**: Basic programming, industrial curiosity
**Exit Level**: Control systems engineer

```
Level 1 (Issues: E1.x) - Foundation
├── IEC 61131-3 languages
├── ISA-88 batch model
├── P&ID symbology
└── Project: Simple control module type

Level 2 (Issues: E2.x) - PLC Programming
├── Structured Text
├── Ladder Logic
├── Function Block Diagrams
└── Project: Multi-vendor code generator

Level 3 (Issues: E3.x) - Process Control
├── PID control theory
├── Alarm management
├── Batch sequences
└── Project: Phase type library

Level 4 (Issues: E4.x) - Safety Systems
├── IEC 61511 SIS
├── Safety Integrity Levels (SIL)
├── Interlock design
└── Project: Safety instrumented function
```

### Track Q: Quality Engineering
**Entry Level**: Testing basics
**Exit Level**: Agentic QE specialist

```
Level 1 (Issues: Q1.x) - Foundation
├── Vitest fundamentals
├── Test patterns
├── Coverage analysis
└── Project: Unit test suite

Level 2 (Issues: Q2.x) - Integration Testing
├── Database testing
├── API contract testing
├── Mock strategies
└── Project: Integration test framework

Level 3 (Issues: Q3.x) - Agentic QE
├── QE agent patterns
├── Automated test generation
├── Mutation testing
└── Project: Test coverage agent

Level 4 (Issues: Q4.x) - Industrial QE
├── Safety-critical testing
├── Protocol simulation
├── Chaos engineering
└── Project: Industrial resilience tests
```

### Track F: Quantum Engineering
**Entry Level**: Linear algebra, basic cryptography concepts
**Exit Level**: Quantum-ready systems architect

```
Level 1 (Issues: F1.x) - Foundation
├── Quantum computing fundamentals
├── Qubits, superposition, entanglement
├── Quantum gates and circuits
└── Project: Quantum circuit simulator setup

Level 2 (Issues: F2.x) - Post-Quantum Cryptography
├── NIST PQC standards (Kyber, Dilithium)
├── Lattice-based cryptography
├── Hash-based signatures (SPHINCS+)
└── Project: PQC library integration

Level 3 (Issues: F3.x) - Quantum Algorithms
├── Grover's and Shor's algorithms
├── QAOA for optimization
├── Variational quantum eigensolvers
└── Project: Process optimization prototype

Level 4 (Issues: F4.x) - Quantum-Ready Architecture
├── Crypto agility patterns
├── Hybrid classical-quantum systems
├── QKD protocol integration
└── Project: Quantum migration roadmap
```

---

## 📋 GitHub Integration Structure

### Labels

```yaml
# Track Labels (for filtering by learning path)
track:frontend:        "🎨 Track A: Frontend"
track:backend:         "⚙️ Track B: Backend"
track:blockchain:      "⛓️ Track C: Blockchain"
track:systems:         "🐧 Track D: Systems"
track:automation:      "🏭 Track E: Automation"
track:quality:         "✅ Track Q: Quality"
track:quantum:         "⚛️ Track F: Quantum"

# Difficulty Labels
difficulty:beginner:   "🌱 Beginner"
difficulty:intermediate: "🌿 Intermediate"
difficulty:advanced:   "🌳 Advanced"
difficulty:expert:     "🏔️ Expert"

# Type Labels
type:feature:          "✨ Feature"
type:bugfix:           "🐛 Bug Fix"
type:docs:             "📚 Documentation"
type:test:             "🧪 Test"
type:refactor:         "♻️ Refactor"
type:security:         "🔒 Security"

# Phase Labels
phase:6-realtime:      "📡 Phase 6: Real-Time"
phase:7-batch:         "🔄 Phase 7: Batch Runtime"
phase:8-hmi:           "🖥️ Phase 8: HMI Suite"
phase:9-os:            "🐧 Phase 9: OxSCADA OS"
phase:10-decentralized: "🌐 Phase 10: Decentralized"
phase:11-ai:           "🤖 Phase 11: AI & Twins"
phase:12-quantum:      "⚛️ Phase 12: Quantum"

# Status Labels
status:ready:          "🟢 Ready to Start"
status:blocked:        "🔴 Blocked"
status:needs-review:   "🟡 Needs Review"
status:good-first-issue: "👋 Good First Issue"
status:help-wanted:    "🆘 Help Wanted"

# Component Labels
component:server:      "Server"
component:client:      "Client"
component:blockchain:  "Blockchain"
component:kernel:      "Kernel"
component:contracts:   "Smart Contracts"
component:gateway:     "Gateway"
component:agents:      "Agents"
```

### Milestones

```
v2.1.0-realtime     Phase 6: Real-Time Industrial Communication
v2.2.0-batch        Phase 7: ISA-88 Batch Runtime Engine
v2.3.0-hmi          Phase 8: HMI/SCADA Visualization Suite
v3.0.0-os           Phase 9: OxSCADA Operating System
v3.1.0-decentralized Phase 10: Decentralized Network
v3.2.0-ai           Phase 11: AI & Digital Twins
v3.3.0-quantum      Phase 12: Quantum Integration
```

### Project Boards

```
📊 OxSCADA Roadmap (Main Board)
├── 📥 Backlog
├── 🎯 Ready to Start
├── 🚧 In Progress
├── 👀 In Review
└── ✅ Done

🎓 Learning Tracks (Kanban per Track)
├── Track A: Frontend
├── Track B: Backend
├── Track C: Blockchain
├── Track D: Systems
├── Track E: Automation
├── Track Q: Quality
└── Track F: Quantum
```

---

## 🏷️ Issue Numbering Convention

```
[Phase].[Epic].[Issue] - [Track]

Examples:
6.1.1 - B   OPC-UA: Connection manager (Backend Track)
6.1.2 - B   OPC-UA: Session handling
6.1.3 - B   OPC-UA: Subscription management
6.1.4 - Q   OPC-UA: Integration test suite (Quality Track)
6.1.5 - A   OPC-UA: Connection status UI (Frontend Track)

8.1.1 - A   P&ID: SVG rendering engine (Frontend Track)
8.1.2 - A   P&ID: Symbol library
8.1.3 - E   P&ID: ISA-5.1 symbol definitions (Automation Track)
```

---

## 🚀 Getting Started for New Contributors

### 1. Choose Your Track
Pick a track based on your interests and current skills:
- **Frontend (A)**: Love UI/UX, React, visualization
- **Backend (B)**: Systems, APIs, databases
- **Blockchain (C)**: Crypto, decentralization, consensus
- **Systems (D)**: Low-level, kernel, security
- **Automation (E)**: Industrial control, PLCs, SCADA
- **Quality (Q)**: Testing, automation, reliability
- **Quantum (F)**: Post-quantum crypto, quantum algorithms, future-proofing

### 2. Start with "Good First Issues"
Filter by:
```
label:"👋 Good First Issue" label:"track:[your-track]"
```

### 3. Level Up Path
Each track has 4 levels. Complete issues at each level before moving up:
- **Level 1**: Foundation (3-5 issues)
- **Level 2**: Core Competency (5-8 issues)
- **Level 3**: Advanced (5-8 issues)
- **Level 4**: Expert (3-5 issues)

### 4. Earn Track Badges
Contributors earn badges for completing level milestones:
- 🌱 **Seedling**: Complete Level 1
- 🌿 **Growing**: Complete Level 2
- 🌳 **Tree**: Complete Level 3
- 🏔️ **Mountain**: Complete Level 4

### 5. Cross-Track Opportunities
Many issues span multiple tracks. Look for issues with multiple track labels to broaden your skills.

---

## 📐 Architecture Decision Records (ADRs)

Key decisions documented in `/docs/adr/`:

| ADR | Decision | Rationale |
|-----|----------|-----------|
| ADR-001 | Off-chain control, on-chain audit | Safety-critical systems need deterministic timing |
| ADR-002 | Merkle batching for events | 95-99% gas savings, scalability |
| ADR-003 | Clique PoA consensus | 5-second blocks suitable for industrial |
| ADR-004 | Custom Linux kernel | PREEMPT_RT for real-time guarantees |
| ADR-005 | Multi-vendor code generation | Avoid vendor lock-in |
| ADR-006 | Agentic governance | Human-in-loop for critical changes |

---

## 📊 Success Metrics

### Per-Phase Completion Criteria

| Phase | Criteria | Measurement |
|-------|----------|-------------|
| 6 | Real PLC communication | Round-trip latency < 100ms |
| 7 | Batch execution | Complete ISA-88 unit procedure |
| 8 | HMI generation | Auto-generate screens from blueprints |
| 9 | OxSCADA OS | Boot to operational in < 30s |
| 10 | Decentralization | 5+ independent validator nodes |
| 11 | AI integration | 80% code suggestion acceptance |
| 12 | Quantum readiness | PQC migration complete, crypto agility verified |

### Community Metrics

| Metric | Target | Description |
|--------|--------|-------------|
| Contributors | 50+ | Active contributors across all tracks |
| Issue Resolution | < 2 weeks | Average time from open to close |
| Test Coverage | > 80% | Code coverage across all modules |
| Documentation | 100% | All APIs and components documented |

---

## 🔗 Quick Links

- **Main Repository**: github.com/[org]/0xscada
- **Documentation**: /docs/
- **API Reference**: /docs/API.md
- **Contributing Guide**: /CONTRIBUTING.md
- **Code of Conduct**: /CODE_OF_CONDUCT.md
- **Discord/Slack**: [Community Link]

---

## 📅 Release Schedule

| Version | Target | Focus |
|---------|--------|-------|
| v2.1.0 | Q1 2026 | Real-time industrial communication |
| v2.2.0 | Q2 2026 | ISA-88 batch runtime |
| v2.3.0 | Q3 2026 | HMI/SCADA visualization |
| v3.0.0 | Q4 2026 | OxSCADA operating system |
| v3.1.0 | Q1 2027 | Decentralized network |
| v3.2.0 | Q2 2027 | AI & digital twins |
| v3.3.0 | Q3 2027 | Quantum integration & crypto agility |

---

*This roadmap is a living document. Updates are made as the project evolves.*

**Last Updated**: January 2026
**Version**: 2.0.0
