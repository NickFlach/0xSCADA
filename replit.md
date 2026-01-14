# 0x_SCADA - Decentralized Industrial Control Fabric

## Overview
0x_SCADA is a prototype for a DePIN-style, blockchain-backed industrial SCADA system. Its primary purpose is to provide a tamper-evident audit trail for industrial operations by leveraging blockchain for identity, audit, compliance, and event anchoring, while keeping real-time control logic off-chain for safety. The system is designed to visualize and manage industrial operations and events across four layers: Field, Gateway, Blockchain, and a Dashboard UI. The project aims to provide a robust, auditable, and secure framework for industrial control systems.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Components
- **Backend (Express + TypeScript)**: An Express server handling API routes, database operations via Drizzle ORM (PostgreSQL), blockchain integration with ethers.js, a field simulator for events, and a blueprints engine for industrial control system code generation.
- **Frontend (React + Vite + TailwindCSS)**: A React 18 SPA with TypeScript, using Vite, TailwindCSS (brutalist dark theme with acid green accent), TanStack React Query for state, Wouter for routing, and shadcn/ui for components. It features pages for operations monitoring, site/asset management, event logging, digital twins (IEC 63278 AAS), blueprint management, vendor management, and code generation.
- **Database (PostgreSQL + Drizzle ORM)**: Stores core data like Sites, Assets, EventAnchors, and MaintenanceRecords. It also supports ISA-88 model data for Blueprints (Vendors, TemplatePackages, ControlModuleTypes, UnitTypes, PhaseTypes, DesignSpecifications, GeneratedCode, DataTypeMappings, Controllers) and IEC 63278 AAS data for Digital Twins.
- **Smart Contracts (Hardhat/Solidity)**: `IndustrialRegistry.sol` manages site and asset registration, and anchors events and maintenance records on Ethereum-compatible blockchains, strictly for audit and identity, not control logic.
- **Build System**: Uses `npm run dev` for development (Express with Vite middleware) and `npm run build` for production (esbuild for server, Vite for client).

### Key Features
- **Blueprints Module**: Generates Siemens SCL and Rockwell L5X/AOI code from industrial control system blueprints, supporting various control module, unit, and phase types.
- **Digital Twin (IEC 63278 AAS)**: Implements Asset Administration Shells for managing digital representations of industrial assets, including submodels and elements, with capabilities to sync physical assets to AAS.
- **Ladder Logic Agent**: Provides AI-driven ladder logic code generation for Rockwell Studio 5000, including an instruction library and batch rung generation.
- **High-Volume Event Anchoring**: Implements a batch anchoring system using Merkle trees for efficient, gas-optimized blockchain anchoring of events, including preliminary support for EIP-4844 blob transactions.

## External Dependencies

### Database
- **PostgreSQL**: Primary data store.
- **Drizzle ORM**: For type-safe database interactions.

### Blockchain
- **Custom Geth Fork**: A custom go-ethereum fork (`geth-fork/`) with Chain ID 380634 (0x5CADA), Clique PoA consensus, and 5-second block time, used as the target blockchain.
- **Hardhat**: For smart contract development and testing.
- **ethers.js**: For Ethereum interaction.

### Frontend Libraries
- **TanStack Query**: Server state management.
- **Framer Motion**: Animations.
- **Lucide React**: Icon library.
- **date-fns**: Date utilities.

### Operating System
- **Linux Kernel Fork**: A fork of the mainline Linux kernel (6.19.0-rc5) in `linux-fork/` for custom industrial OS development, focusing on industrial I/O (IIO), GPIO, SPI, and I2C drivers.

### Development Tools
- **Vite**: Frontend development server.
- **tsx**: TypeScript execution for Node.js.
- **esbuild**: Production server bundling.