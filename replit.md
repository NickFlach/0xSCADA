# 0x_SCADA - Decentralized Industrial Control Fabric

## Overview

0x_SCADA is a DePIN-style, blockchain-backed industrial SCADA system prototype. The core principle is that real-time control logic stays safely off-chain, while blockchain is used exclusively for identity, audit, compliance, and event anchoring. This creates a tamper-evident audit trail for industrial operations without compromising safety-critical control systems.

The system models four layers:
- **Field Layer**: Simulated PLCs/RTUs generating industrial events (breaker trips, setpoint changes)
- **Gateway Layer**: Express API that hashes events, anchors to blockchain, stores payloads in PostgreSQL
- **Blockchain Layer**: Hardhat-based Ethereum smart contracts for immutable registry and audit logs
- **Dashboard UI**: React/Vite SPA for operations monitoring and event visualization

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend (Express + TypeScript)
- **Entry Point**: `server/index.ts` - Express server with HTTP/WebSocket support
- **API Routes**: `server/routes.ts` - REST endpoints for Sites, Assets, Events, Maintenance, Blueprints, Vendors, and Code Generation
- **Storage**: `server/storage.ts` - Database operations using Drizzle ORM with PostgreSQL
- **Blockchain Service**: `server/blockchain.ts` - Ethereum integration via ethers.js for on-chain anchoring
- **Field Simulator**: `server/simulator.ts` - Generates simulated industrial events for demo purposes
- **Blueprints Engine**: `server/blueprints/` - Industrial control system blueprints and code generation

### Blueprints Module (`server/blueprints/`)
- **code-generator.ts**: Core code generation engine with template processing
- **siemens-adapter.ts**: Generates Siemens SCL (Structured Control Language) code
- **rockwell-adapter.ts**: Generates Rockwell L5X/AOI format code
- **seed-database.ts**: Seeds vendors, templates, and data type mappings
- **importer.ts**: Imports blueprints from CSV files
- **cm-type-parser.ts**: Parses control module type definitions
- **unit-type-parser.ts**: Parses unit type definitions
- **phase-type-parser.ts**: Parses phase type definitions

### Frontend (React + Vite + TailwindCSS)
- **Framework**: React 18 with TypeScript, Vite bundler
- **Styling**: TailwindCSS v4 with a brutalist dark theme (acid green accent)
- **State Management**: TanStack React Query for server state
- **Routing**: Wouter for client-side routing
- **UI Components**: shadcn/ui component library with Radix primitives
- **Pages**:
  - **Home**: Landing page with feature overview
  - **Dashboard**: Operations console with stats and event stream
  - **Sites**: Industrial site registry
  - **Events**: Audit log viewer
  - **Blueprints**: Control module, unit, and phase type library
  - **Vendors**: Vendor management with templates and data type mappings
  - **CodeGen**: Code generation interface for Siemens/Rockwell PLC code

### Database Schema (Drizzle ORM)
Defined in `shared/schema.ts`:

**Core Tables:**
- **Sites**: Industrial locations with owner addresses and status
- **Assets**: Equipment (transformers, breakers, MCCs) linked to sites
- **EventAnchors**: Hashed industrial events with blockchain transaction references
- **MaintenanceRecords**: Work orders with compliance tracking

**Blueprints Tables (ISA-88 Model):**
- **Vendors**: Industrial automation vendors (Siemens, Rockwell, ABB, Emerson, Schneider)
- **TemplatePackages**: Code templates for SCL, AOI, Ladder logic
- **ControlModuleTypes**: PID controllers, valves, VFDs, etc.
- **ControlModuleInstances**: Actual instances of control modules
- **UnitTypes**: Tanks, reactors, etc. (ISA-88 batch concepts)
- **UnitInstances**: Actual unit instances
- **PhaseTypes**: Batch control phase definitions
- **PhaseInstances**: Actual phase instances
- **DesignSpecifications**: Versioned FDS documents with blockchain anchoring
- **GeneratedCode**: Template output with audit trail and hash verification
- **DataTypeMappings**: Vendor-specific data type translations
- **Controllers**: PLC/DCS hardware definitions

### Smart Contracts (Hardhat/Solidity)
- **IndustrialRegistry.sol**: Registers Sites and Assets, anchors Events and Maintenance records
- **Target**: Ethereum-compatible chains (local Hardhat node for development)
- **Safety Principle**: NO control logic on-chain - only audit/identity functions

### Build System
- **Development**: `npm run dev` starts Express server with Vite middleware
- **Production**: `npm run build` uses custom esbuild script for server bundling and Vite for client
- **Database**: `npm run db:push` applies Drizzle schema to PostgreSQL

## API Endpoints

### Core Operations
- `GET/POST /api/sites` - Site management
- `GET/POST /api/assets` - Asset management
- `GET/POST /api/events` - Event anchoring
- `GET/POST /api/maintenance` - Maintenance records
- `GET /api/blockchain/status` - Blockchain connection status

### Blueprints
- `GET/POST /api/blueprints/cm-types` - Control module types
- `GET /api/blueprints/cm-instances` - Control module instances
- `GET/POST /api/blueprints/unit-types` - Unit types
- `GET /api/blueprints/unit-instances` - Unit instances
- `GET/POST /api/blueprints/phase-types` - Phase types
- `GET /api/blueprints/phase-instances` - Phase instances
- `GET /api/blueprints/design-specs` - Design specifications
- `GET /api/blueprints/summary` - Blueprint counts summary
- `POST /api/blueprints/import` - Import blueprints from CSV
- `POST /api/blueprints/seed` - Seed database with vendors and templates

### Vendors & Templates
- `GET/POST /api/vendors` - Vendor management
- `GET/POST /api/templates` - Template packages
- `GET/POST /api/data-types` - Data type mappings
- `GET/POST /api/controllers` - PLC/DCS controllers

### Code Generation
- `POST /api/generate/control-module/:cmTypeId` - Generate code for control module
- `POST /api/generate/phase/:phaseTypeId` - Generate code for phase
- `GET/POST /api/generated-code` - Generated code management
- `POST /api/generated-code/:id/anchor` - Anchor generated code to blockchain

### Ladder Logic Agent (Rockwell)
- `GET /api/ladder-logic/instructions` - Get instruction library (optional: ?category=bit|timer|counter|compare|math|move|program)
- `POST /api/generate/ladder-logic/control-module/:cmTypeId` - Generate ladder logic for control module
- `POST /api/generate/ladder-logic/phase/:phaseTypeId` - Generate ladder logic for phase
- `POST /api/ladder-logic/batch` - Batch rung generation from template with CSV
- `POST /api/ladder-logic/ai-context/:cmTypeId` - Generate AI prompt context for external AI integration

### Batch Anchoring (High-Volume)
- `GET /api/batch/stats` - Get batch service stats, config, and blockchain status
- `GET /api/batch/history` - Get recent batch anchoring history
- `GET /api/batch/pending` - Get pending events in queue
- `POST /api/batch/flush` - Force immediate batch flush
- `PUT /api/batch/config` - Update batch configuration (maxBatchSize, maxBatchAgeMs, enabled)
- `GET /api/batch/:batchId/proof/:eventId` - Get Merkle proof for an event
- `GET /api/batch/blob/config` - Get EIP-4844 blob configuration
- `PUT /api/batch/blob/config` - Update blob configuration
- `POST /api/batch/blob/estimate` - Estimate blob vs calldata costs

## External Dependencies

### Database
- **PostgreSQL**: Primary data store for full event payloads and system registry
- **Drizzle ORM**: Type-safe database queries with automatic schema inference
- **Connection**: Via `DATABASE_URL` environment variable

### Blockchain
- **Custom Geth Fork**: go-ethereum fork in `geth-fork/` directory
  - Chain ID: 380634 (0x5CADA)
  - Consensus: Clique (Proof of Authority)
  - Block Time: 5 seconds
  - Gas Limit: 30,000,000
- **Hardhat**: Smart contract development and testing (chainId 1337)
- **ethers.js**: Ethereum provider and contract interaction
- **Helper Scripts** (`blockchain/`):
  - `init-chain.sh`: Initialize the custom blockchain
  - `start-node.sh`: Start the geth node
  - `create-account.sh`: Create new signer account
  - `import-key.sh`: Import Hardhat default private key
- **Environment Variables**:
  - `BLOCKCHAIN_RPC_URL`: JSON-RPC endpoint (defaults to localhost:8545)
  - `BLOCKCHAIN_PRIVATE_KEY`: Wallet for signing transactions
  - Contract address read from `deployment.json` after running deploy script

### Frontend Libraries
- **TanStack Query**: Server state management with automatic refetching
- **Framer Motion**: Landing page animations
- **Lucide React**: Icon library
- **date-fns**: Date formatting utilities

### Development Tools
- **Vite**: Frontend dev server with HMR
- **tsx**: TypeScript execution for Node.js
- **esbuild**: Production server bundling

## Recent Changes

### January 11, 2026
- **Custom Blockchain Fork**: Forked go-ethereum for 0xSCADA private blockchain
  - Chain ID: 380634 (0x5CADA) - unique identifier for the network
  - Clique PoA consensus with 5-second block time (ideal for industrial applications)
  - Pre-funded accounts compatible with Hardhat development environment
  - Custom genesis configuration at `blockchain/genesis.json`
  - Build geth binary from source in `geth-fork/build/bin/geth`
  - Helper scripts for chain initialization, node startup, and account management
  - Full control over consensus, gas limits, and network parameters

### January 10, 2026
- **High-Volume Event Anchoring System**: Added batch anchoring with Merkle trees per Grok's recommendations
  - `BatchAnchoringService`: Queues events and builds Merkle trees for efficient L1 anchoring
  - `anchorBatchRoot()` smart contract function: Anchors batched event roots instead of individual events
  - `verifyEventInBatch()`: On-chain Merkle proof verification for audit trails
  - Configurable batch cadence (size-based or time-based triggers)
  - 95-99% gas savings compared to individual event anchoring
  - API endpoints: `/api/batch/stats`, `/api/batch/history`, `/api/batch/flush`, `/api/batch/config`
- **EIP-4844 Blob Support (Prototype)**: Optional blob posting for ultra-high-throughput deployments
  - `BlobAnchoringService`: Prepares blob payloads with KZG commitments
  - Cost estimation for blob vs calldata anchoring
  - API endpoints: `/api/batch/blob/config`, `/api/batch/blob/estimate`
- **Gas Cost Benchmarking**: Script to measure and project anchoring costs
  - Run with: `npx hardhat run scripts/benchmark-gas.ts --network localhost`
  - Compares individual vs batched anchoring gas usage
  - Projects daily/monthly costs for various plant sizes
- **Documentation**: Added `docs/ANCHORING.md` contributor guide
- **GitHub Templates**: Issue templates for anchoring optimizations and good first issues

### January 8, 2026
- **Ladder Logic Agent**: Added AI-driven ladder logic code generation for Rockwell Studio 5000
  - Instruction library with all standard Studio 5000 instructions (XIC, XIO, OTE, TON, CTU, etc.)
  - Neutral text format generation and parsing
  - RungBuilder fluent API for programmatic rung construction
  - Batch rung generation with template variables and CSV substitution
  - AI context generation for external AI integration
  - Full API routes for ladder logic generation
  - Updated CodeGen page with Ladder Logic tab and generation options

### December 30, 2025
- Added comprehensive blueprints and vendor management system
- Implemented code generation for Siemens SCL and Rockwell L5X formats
- Created new frontend pages: Blueprints, Vendors, CodeGen
- Added 12 new database tables for ISA-88 model support
- Seeded database with 5 vendors, 36 data type mappings, 4 templates
- Created sample control module types: PIDController, AnalogValve, VFD_Motor
