# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs) for the 0xSCADA project.

## What is an ADR?

An Architecture Decision Record (ADR) is a document that captures an important architectural decision made along with its context and consequences.

## ADR Format

We use the [MADR (Markdown ADR)](https://adr.github.io/madr/) format with some customizations.

## Status Lifecycle

ADRs follow this lifecycle:

- **Proposed** - Under discussion, not yet accepted
- **Accepted** - Decision has been approved and is in effect
- **Deprecated** - No longer relevant but kept for historical context
- **Superseded** - Replaced by a newer ADR (link to replacement)

## ADR Index

<!-- ADR-INDEX-START -->
| Number | Title | Status |
|--------|-------|--------|
| [ADR-0001](ADR-0001-hybrid-on-off-chain-architecture.md) | Hybrid On-Chain/Off-Chain Architecture | Accepted |
| [ADR-0002](ADR-0002-merkle-tree-batching.md) | Merkle Tree Batching for Gas Optimization | Accepted |
| [ADR-0003](ADR-0003-clique-poa-consensus.md) | Clique PoA Consensus Selection | Accepted |
| [ADR-0004](ADR-0004-preempt-rt-kernel.md) | PREEMPT_RT Kernel for Real-Time Control | Accepted |
| [ADR-0005](ADR-0005-opcua-protocol-driver.md) | OPC-UA as Primary Protocol Driver | Accepted |
| [ADR-0006](ADR-0006-postgresql-event-persistence.md) | PostgreSQL for Event Persistence | Accepted |
| [ADR-0007](ADR-0007-agent-based-governance.md) | Agent-Based Governance Model | Accepted |
| [ADR-0008](ADR-0008-zero-trust-agent-deployment.md) | Zero-Trust Agent Deployment Model | Proposed |
| [ADR-0009](ADR-0009-measured-emergence-guardrails.md) | Measured Emergence Guardrails for Autonomous Agents | Proposed |
| [ADR-0010](ADR-0010-agent-certification-framework.md) | Agent Certification Framework | Proposed |
| [ADR-0011](ADR-0011-ot-it-convergence-standards.md) | OT/IT Convergence Standards for Agentic Systems | Proposed |
<!-- ADR-INDEX-END -->

## Creating a New ADR

1. Copy the template from `_template.md`
2. Name your file: `ADR-NNNN-title-slug.md` (use next available number)
3. Fill in all sections
4. Submit as a PR for review
5. Once merged with "Accepted" status, the decision is in effect

## Template

See [_template.md](_template.md) for the standard ADR template.
