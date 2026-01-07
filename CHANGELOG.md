# Changelog

All notable changes to 0xSCADA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-01-06

### Added

#### Agentic-First Architecture (PRD Phase 0 & 1)

##### Event Model (PRD Section 6.1)
- **Typed Events** - 8 event types: Telemetry, Alarm, Command, Acknowledgement, Maintenance, BlueprintChange, CodeGeneration, DeploymentIntent
- **Dual Timestamps** - Source timestamp (when occurred) + Receipt timestamp (when received)
- **Origin Tracking** - Every event signed by origin (Gateway, User, Agent, System)
- **Deterministic Serialization** - Canonical JSON for consistent hashing
- **Event Signing** - HMAC-SHA256 signatures on all events
- **Anchor Status** - Track PENDING → BATCHED → ANCHORED lifecycle

##### Merkle Batching System (PRD Section 7.2)
- **Event Accumulator** - Collect events for batch anchoring
- **Merkle Tree Builder** - Compute Merkle roots for event batches
- **Batch Manager** - Manage batch lifecycle and anchoring
- **Merkle Proofs** - Generate and verify inclusion proofs

##### Agent Framework (PRD Section 6.3)
- **Agent Registry** - Register, start, stop agents with lifecycle management
- **Agent Identity** - Cryptographic identity with public/private keys
- **Agent Capabilities** - Fine-grained capability system (READ_EVENTS, PROPOSE_CHANGES, etc.)
- **Agent Scope** - Site/asset/event type access control
- **Agent State** - Scoped memory with key-value storage and expiration
- **Signed Outputs** - All agent outputs cryptographically signed

##### P0 Agents (PRD Section 6.4)
- **Ops Agent** - Plant state summaries, shift handoff reports, anomaly detection
- **Change-Control Agent** - Blueprint change tracking, code generation, change packages with diffs/test plans/rollback steps
- **Compliance Agent** - Audit evidence generation, anchor verification, compliance reports

##### Ethereum Contracts (PRD Section 7)
- **SiteRegistry.sol** - Site registration with authorized gateways and signers
- **EventAnchor.sol** - Merkle root anchoring with metadata pointers
- **ChangeIntent.sol** - Blueprint/codegen hash anchoring with multi-sig approval

##### Gateway Support (PRD Section 6.2)
- **Gateway Schema** - Device identity, key management, protocol support
- **Protocol Configuration** - OPC UA + legacy protocol support fields

##### User Management (PRD Section 4.1)
- **User Schema** - Users with roles (Engineer, Operator, Maintenance, Auditor, Admin)
- **Cryptographic Identity** - Optional public key and Ethereum address
- **Site Scoping** - Users can be scoped to specific sites

##### Change Intents (PRD Section 7.3)
- **Change Package** - Diffs, test plans, rollback steps
- **Approval Workflow** - Multi-signature approval chain
- **Deployment Tracking** - Track deployed/rolled-back status
- **Intent Anchoring** - Ethereum anchoring before deployment

#### User Interface

##### Agent Dashboard (`/agents`)
- **Agent Cards** - View all registered agents with status and capabilities
- **Proposal Management** - View, approve, reject agent proposals
- **Activity Feed** - Real-time agent output stream
- **Risk Indicators** - Visual risk level badges on proposals

##### Verification Components
- **VerificationBadge** - Click-to-verify with hash, Merkle proof, Ethereum tx
- **AnchorStatusIndicator** - Visual status (✔ anchored / ⏳ pending)

#### API Endpoints

##### Agent API (`/api/agents`)
- `GET /api/agents` - List all agents
- `GET /api/agents/:id` - Get agent by ID
- `POST /api/agents` - Create agent
- `PATCH /api/agents/:id` - Update agent
- `DELETE /api/agents/:id` - Delete agent
- `GET /api/agents/:id/state` - Get agent state
- `PUT /api/agents/:id/state/:key` - Set state value
- `DELETE /api/agents/:id/state/:key` - Delete state value
- `GET /api/agents/:id/outputs` - Get agent outputs
- `POST /api/agents/:id/outputs` - Create output
- `GET /api/agents/:id/proposals` - Get agent proposals
- `POST /api/agents/:id/proposals` - Create proposal
- `POST /api/agent-proposals/:id/approve` - Approve proposal
- `POST /api/agent-proposals/:id/reject` - Reject proposal

#### Infrastructure

##### Cryptographic Infrastructure (`server/crypto`)
- Canonical JSON serialization
- SHA-256 hashing
- HMAC-SHA256 signing
- Merkle tree construction and verification
- Ethereum address validation

##### Database Migration
- `migrations/0002_agentic_update.sql` - Full schema migration for v2.0

### Changed
- **Sites Table** - Added `ethereum_address`, `authorized_gateways`, `authorized_signers`
- **Navbar** - Added Agents link with Bot icon

#### Phase 1: Evolved Events API (`/api/v2/events`)
- `GET /api/v2/events` - List events with filtering (site, asset, type, origin, status, time range)
- `GET /api/v2/events/:id` - Get event with batch info and verification details
- `GET /api/v2/events/:id/verify` - Verify event hash, signature, and Merkle proof
- `POST /api/v2/events` - Create any event type with deterministic signing
- `POST /api/v2/events/telemetry` - Convenience endpoint for telemetry
- `POST /api/v2/events/alarm` - Convenience endpoint for alarms
- `POST /api/v2/events/command` - Convenience endpoint for commands
- `GET /api/v2/events/batches` - List Merkle batches
- `GET /api/v2/events/batches/:id` - Get batch with events
- `POST /api/v2/events/batches/:id/anchor` - Trigger batch anchoring
- `GET /api/v2/events/stats` - Event statistics
- `GET /api/v2/events/types` - Available event types and origins

#### Phase 2: Agent Runtime Service (`server/agents/runtime.ts`)
- **AgentRuntime** - Lifecycle management, event routing, proposal workflow
- **Event Subscription** - Automatic event routing based on agent scope
- **Proposal Creation** - Signed proposals with risk assessment
- **Approval Workflow** - Multi-signature approval with audit trail
- **Output Storage** - Cryptographically signed agent outputs
- **Audit Logging** - Complete audit trail for all agent actions

#### Phase 3: Edge Gateway Service (`server/gateway`)
- **EdgeGateway** - Core gateway class with event emission
- **Protocol Drivers** - OPC UA and Modbus TCP drivers (simulated)
- **Tag Management** - Register, subscribe, and monitor tags
- **Alarm Detection** - Automatic alarm generation from tag values
- **Store-and-Forward** - Queue events during network outages
- **Heartbeat** - Periodic gateway status events
- **Gateway Registry** - Manage multiple gateways

#### Phase 4: Visualization Components
- **LiveTagsPanel** - Real-time tag display with sparklines, quality, trends
- **ProposalsPanel** - View/approve/reject agent proposals with risk indicators
- **ApprovalChain** - Visual approval progress indicator
- **RiskLevelBadge** - Color-coded risk level display

#### Phase 5: Zero Trust Security (`server/security`)
- **KeyManager** - Key generation, storage, rotation, expiration
- **RBACService** - Role-based access control with 6 roles, 17 permissions
- **AuditService** - Cryptographically chained audit log with integrity verification
- **SessionManager** - Session creation, validation, MFA support
- **SecurityService** - Unified facade for authentication and authorization

### Technical Notes
- All lint errors in IDE are path resolution issues - modules exist in `node_modules`
- TypeScript target is ES2022, supporting Map iteration
- Existing patterns from v1.0 maintained for consistency
- EventEmitter inheritance works at runtime despite IDE errors

---

## [1.0.0] - 2024-12-30

### Added

#### Core SCADA Platform
- **Site Management** - Register and manage industrial sites with blockchain anchoring
- **Asset Registry** - Track assets with criticality levels and status monitoring
- **Event Anchoring** - Immutable audit trail for all industrial events
- **Maintenance Records** - Blockchain-anchored maintenance history

#### Blueprints Integration
- **Multi-Vendor Code Generation** - Generate PLC code for multiple vendors:
  - Siemens TIA Portal (SCL)
  - Rockwell Automation (AOI/L5X)
  - ABB (Structured Text)
  - Emerson DeltaV (Structured Text)
  - Schneider Electric (Structured Text)
- **Control Module Types** - Define reusable control module blueprints with I/O definitions
- **Unit Types** - ISA-88 compliant unit definitions
- **Phase Types** - Batch control phase definitions with sequence logic
- **Instance Management** - Track deployed instances of blueprints
- **Design Specification Import** - Parse markdown and CSV blueprint files

#### User Interface
- **Dashboard** - Real-time overview of sites, assets, and events
- **Blueprints Library** - Browse and manage CM/Unit/Phase types
- **Code Generator** - Interactive code generation with vendor selection
- **Vendor Management** - View vendors and their templates
- **Import Wizard** - Drag-and-drop blueprint file import

#### API
- RESTful API with comprehensive endpoints
- Health check endpoint for monitoring
- Blueprints summary endpoint
- Code generation endpoints with hash verification

#### Infrastructure
- **Docker Support** - Production-ready Dockerfile and docker-compose
- **CI/CD Pipeline** - GitHub Actions workflow for testing and building
- **Security Middleware** - Production security headers and rate limiting
- **Database** - PostgreSQL with Drizzle ORM

#### Documentation
- Comprehensive README with architecture overview
- API documentation with request/response examples
- Contributing guidelines
- Apache 2.0 License

### Security
- Blockchain anchoring for immutable audit trails
- Code hash generation for integrity verification
- Security headers middleware
- Rate limiting support

---

## [Unreleased]

### Planned
- Additional vendor adapters (Honeywell, Yokogawa)
- Real-time WebSocket updates
- User authentication and authorization
- Multi-tenant support
- Batch recipe management
- Equipment phase integration
- Advanced reporting and analytics

---

## Version History

| Version | Date | Description |
|---------|------|-------------|
| 1.0.0 | 2024-12-30 | Initial release with Blueprints integration |

---

## Migration Notes

### Upgrading to 1.0.0

This is the initial release. No migration required.

### Database Schema

Run the following to initialize the database:

```bash
npm run db:push
```

### Environment Variables

Ensure the following are configured:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/oxscada
HARDHAT_RPC_URL=http://127.0.0.1:8545
```

---

## Contributors

- The ESCO Group
- Community Contributors

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.
