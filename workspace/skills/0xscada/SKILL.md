---
name: 0xscada
description: >
  Decentralized Industrial Control Fabric. Bridges SCADA systems with
  blockchain-backed audit trails and Kannaka memory integration.
  Provides a unified API for telemetry, geometry classification,
  and verifiable industrial state.
metadata:
  openclaw:
    requires:
      bins:
        - name: node
          label: "Node.js 18+  required to run the server"
        - name: npm
          label: "npm  required for installation"
      env: []
    optional:
      bins:
        - name: docker
          label: "Docker  optional for local database/redis"
      env:
        - name: SCADA_PORT
          label: "HTTP port for the 0xSCADA server (default: 5000)"
        - name: DATABASE_URL
          label: "PostgreSQL connection string"
    data_destinations:
      - id: scada-local
        description: "Local industrial telemetry"
        remote: false
    install:
      - id: npm-install
        kind: command
        label: "Install dependencies"
        command: "npm install"
---

# 0xSCADA Skill

Decentralized Industrial Control Fabric mapping atoms to bits. Integrates natively with the Kannaka memory ecosystem (84-class SGA Fano geometry).

## Prerequisites

- **Node.js 18+** on PATH
- **npm** on PATH
- **PostgreSQL** (optional, uses SQLite by default if not set up)

## Setup

```bash
cd ~/workspace/skills/0xscada
npm install
```

## Quick Start

```bash
# Start 0xSCADA
./scripts/0xscada.sh start

# Check status
./scripts/0xscada.sh status
```
