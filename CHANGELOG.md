# Changelog

All notable changes to 0xSCADA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
