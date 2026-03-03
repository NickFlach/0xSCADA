# ADR-0016: Rust Unikernel — 0xSCADA-OS

> **Status:** Proposed  
> **Date:** 2026-03-02  
> **Supersedes:** Kernel Fork Plan (linux-fork, deleted in #205)  
> **Related:** ADR-0008 (Zero-Trust), ADR-0011 (OT-IT Convergence), ADR-0012–0014 (Integration/Agents/Production)

## Context

The original `linux-fork/` (~30,000 files, 1.5 GB) carried an entire Linux 6.6 kernel to host four custom modules: `oxscada-event`, `oxscada-crypto`, `oxscada-bridge`, and `oxscada-watchdog`. This was accidental baggage — the actual 0xSCADA kernel IP is small. The fork was deleted in commit `6f9d9219c` and we're not bringing it back.

0xSCADA needs to run its own worldwide OT network (the **System Integrator Network / SIN**) where every node is a sovereign SCADA controller with native Ethereum attestation and Flux world-state participation. A full Linux kernel is dead weight for this purpose.

## Decision

Build **0xSCADA-OS**: a purpose-built Rust unikernel that boots bare metal and runs nothing but the 0xSCADA protocol stack. No Linux, no containers, no general-purpose OS.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        0xSCADA-OS                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Application Layer                                        │   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌───────────────────┐  │   │
│  │  │ SCADA Engine │ │ AI Agent Rt  │ │ Admin / HMI API   │  │   │
│  │  │ (tags, alarms│ │ (autonomous  │ │ (REST/WS, thin)   │  │   │
│  │  │  P&ID, hist) │ │  OT agents)  │ │                   │  │   │
│  │  └──────┬───────┘ └──────┬───────┘ └───────┬───────────┘  │   │
│  └─────────┼────────────────┼─────────────────┼──────────────┘   │
│            │                │                 │                   │
│  ┌─────────▼────────────────▼─────────────────▼──────────────┐   │
│  │  Protocol Layer                                            │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │   │
│  │  │ Resonant │ │ Chiral   │ │ Flux     │ │ Ethereum    │  │   │
│  │  │ Consensus│ │ Network  │ │ Native   │ │ L2 Anchor   │  │   │
│  │  │ (RCP)    │ │ Stack    │ │ Client   │ │ + Submitter │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────────┘  │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────────────┐  │   │
│  │  │ OPC-UA   │ │ Modbus   │ │ Industrial Protocol Ext  │  │   │
│  │  │ Server   │ │ TCP/RTU  │ │ (DNP3, IEC 61850, etc.)  │  │   │
│  │  └──────────┘ └──────────┘ └──────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Kernel Layer (Rust, no_std where possible)                │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │   │
│  │  │ Resonant     │ │ Event Ring   │ │ Crypto Engine    │  │   │
│  │  │ Scheduler    │ │ Buffer       │ │ (HSM, Keccak,    │  │   │
│  │  │ (Kuramoto    │ │ (lock-free,  │ │  Merkle proofs,  │  │   │
│  │  │  λ-adaptive) │ │  zero-copy)  │ │  secp256k1)      │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────┘  │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │   │
│  │  │ Memory Mgr   │ │ Driver Model │ │ Watchdog +       │  │   │
│  │  │ (slab alloc, │ │ (GPIO, SPI,  │ │ Health Monitor   │  │   │
│  │  │  no fragmnt) │ │  I2C, UART,  │ │ (consensus-aware │  │   │
│  │  │              │ │  Ethernet)   │ │  failover)       │  │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────┘  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  HAL (Hardware Abstraction Layer)                          │   │
│  │  x86_64 │ ARM64 (Cortex-A) │ RISC-V                      │   │
│  │  Boot: UEFI/Multiboot2 │ DTB for ARM │ SBI for RISC-V    │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## The SIN (System Integrator Network)

Every 0xSCADA-OS node is simultaneously:

1. **A SCADA controller** — reads sensors, drives actuators, runs control logic
2. **A Flux entity** — publishes state to the world graph, subscribes to peers, reacts to cross-network events
3. **An Ethereum attestor** — batches events into Merkle roots, anchors to L2, verifies proofs from peers
4. **A consensus participant** — resonant consensus (RCP) for local cluster agreement
5. **A chiral network node** — Byzantine-resistant routing with L-path/R-path separation

The SIN forms when nodes discover each other via Flux and establish chiral routing relationships. There is no central coordinator. The network self-organizes via gossip + resonant consensus.

```
           ┌──────────────┐
     Flux  │   World      │  Flux
   ┌──────►│   State      │◄──────┐
   │       │   Graph      │       │
   │       └──────────────┘       │
   │                              │
┌──┴───┐  chiral route  ┌────────┴─┐  chiral route  ┌─────────┐
│Node A│◄──────────────►│  Node B  │◄──────────────►│ Node C  │
│water │  L2 attestation │  power   │  L2 attestation│ refinery│
│plant │                 │  grid    │                │         │
└──────┘                 └──────────┘                └─────────┘
   │                         │                           │
   ▼                         ▼                           ▼
 PLCs                      RTUs                        DCS
 sensors                   meters                      valves
```

## Native Flux Integration

Flux is not a sidecar or middleware — it's baked into the kernel:

- **Entity lifecycle** tied to boot/shutdown — node registers on Flux at boot, deregisters on graceful shutdown
- **Property updates** are zero-copy from the event ring buffer to Flux wire format (NATS)
- **Subscriptions** drive control logic — a downstream node reacts to upstream state changes in real-time
- **Namespace isolation** — each SIN deployment is a Flux namespace (`pure-jade`, etc.)
- **NATS JetStream** for durable event streams when nodes are temporarily offline

## Native Ethereum Integration

No ethers.js, no JSON-RPC proxy. The kernel speaks Ethereum natively:

- **secp256k1** key management in the crypto engine (HSM-backed where available)
- **RLP encoding** for transaction construction
- **Merkle proof** generation and verification in kernel space
- **Batch submission** via direct TCP to L2 RPC endpoint
- **State root import** from L2 for bidirectional verification

## Real-Time Guarantees

| Metric | Target | Mechanism |
|--------|--------|-----------|
| Interrupt latency | < 10 µs | No kernel preemption needed (unikernel = cooperative) |
| Event-to-ring | < 1 µs | Lock-free SPSC ring buffer, zero-copy |
| Sensor poll cycle | 1 ms | Resonant scheduler, Kuramoto-coupled |
| Batch anchor interval | 1–60 s | Configurable, gas-optimized |
| Flux state propagation | < 5 ms | Direct NATS publish from event handler |
| Chiral route convergence | < 30 s | Gossip protocol, reputation-weighted |

## Why Not Linux?

| Concern | Linux | 0xSCADA-OS |
|---------|-------|------------|
| Boot time | 3–15 s | < 500 ms |
| Memory footprint | 128+ MB | < 16 MB |
| Attack surface | ~30M LOC | < 50K LOC |
| Determinism | PREEMPT_RT patches, still not guaranteed | Single-address-space, no context switch overhead |
| Supply chain | 30,000 files of someone else's code | Every line auditable |
| Update model | Distro packages, CVE treadmill | Signed firmware images, atomic swap |

## Build Targets

- **x86_64** — development, VM testing, server-class edge gateways
- **ARM64 (Cortex-A53/A72)** — Raspberry Pi CM4, industrial SBCs
- **RISC-V** — future-proof, open silicon alignment

## Phased Delivery

### Phase 0: Skeleton (Weeks 1–4)
- Rust `no_std` boot on x86_64 (UEFI/Multiboot2)
- Serial console, basic memory allocator (bump → slab)
- Interrupts, timer, simple cooperative scheduler
- "Hello from 0xSCADA-OS" over serial

### Phase 1: Networking + Flux (Weeks 5–10)
- virtio-net driver (for QEMU/KVM development)
- Minimal TCP/IP stack (smoltcp or custom)
- NATS client (Flux wire protocol)
- Node boots → registers as Flux entity → publishes heartbeat
- Basic chiral routing (L-table/R-table, gossip)

### Phase 2: SCADA Core (Weeks 11–18)
- Event ring buffer (lock-free, zero-copy)
- OPC-UA server (minimal profile)
- Modbus TCP client/server
- Tag engine, alarm state machine
- Resonant scheduler (Kuramoto + λ-adaptive damping)

### Phase 3: Ethereum + Consensus (Weeks 19–26)
- secp256k1, Keccak-256, RLP encoding
- Merkle tree construction + proof verification
- Batch anchor submission to L2
- Resonant consensus protocol (signal → resonance → emergence)
- Bidirectional state sync

### Phase 4: Production Hardening (Weeks 27+)
- ARM64 HAL + real hardware bring-up
- HSM integration (TPM 2.0 / PKCS#11)
- Secure boot chain (measured boot → attestation)
- OTA firmware update (A/B partition, signed images)
- IEC 62443 compliance mapping

## Repo Structure

```
0xSCADA/
├── kernel/              # 0xSCADA-OS Rust unikernel
│   ├── src/
│   │   ├── arch/        # HAL: x86_64, aarch64, riscv64
│   │   ├── boot/        # UEFI/Multiboot2 entry
│   │   ├── mem/         # Allocator, page tables
│   │   ├── sched/       # Resonant scheduler
│   │   ├── event/       # Ring buffer, event pipeline
│   │   ├── crypto/      # secp256k1, Keccak, Merkle, HSM
│   │   ├── net/         # TCP/IP, chiral routing, NATS/Flux
│   │   ├── eth/         # Ethereum L2 client, RLP, batch anchor
│   │   ├── scada/       # Tag engine, alarms, OPC-UA, Modbus
│   │   ├── consensus/   # Resonant consensus protocol
│   │   └── watchdog/    # Health, failover
│   ├── Cargo.toml
│   └── link.ld          # Linker script per arch
├── contracts/           # Solidity (existing)
├── client/              # Web UI (existing)
├── server/              # Node.js API (existing, eventually replaced)
├── docs/                # (existing)
└── tools/
    ├── qemu-run.sh      # QEMU launcher for dev
    └── flash.sh         # Firmware flash utility
```

## Risks

| Risk | Mitigation |
|------|------------|
| Scope creep (it's an OS) | Ruthless scoping — Phase 0 is just "boot and print". Each phase ships independently. |
| No_std Rust ecosystem gaps | smoltcp (TCP), embedded-hal (drivers), ring (crypto) are mature. Fill gaps as needed. |
| Hardware compatibility | Start in QEMU. Real hardware only after Phase 2. |
| Single-developer bus factor | Comprehensive docs, ADRs, clean module boundaries. |
| Regulatory (IEC 62443, NERC CIP) | Phase 4 addresses compliance. Architecture designed for it from day 1. |

## Success Criteria

- **Phase 0:** Boots in QEMU, prints to serial, runs a cooperative task
- **Phase 1:** Registers on Flux, visible in world state, chiral routing between 3 QEMU nodes
- **Phase 2:** Reads a simulated Modbus sensor, publishes tag value to Flux, triggers alarm
- **Phase 3:** Anchors event batch to L2 testnet, verifies Merkle proof from peer
- **Phase 4:** Runs on real ARM64 SBC, passes IEC 62443 SL-2 audit

## References

- Existing docs: `kernel-fork-plan.md`, `chiral-network-stack.md`, `resonant-consensus.md`, `resonant-scheduler.md`, `l2-kernel-integration.md`, `bidirectional-sync.md`, `decentralized-orchestration.md`
- Rust OS resources: [Writing an OS in Rust (phil-opp)](https://os.phil-opp.com/), [Redox OS](https://www.redox-os.org/), [Theseus OS](https://github.com/theseus-os/Theseus)
- smoltcp: https://github.com/smoltcp-rs/smoltcp
- Flux: https://flux.eckman-tech.com
