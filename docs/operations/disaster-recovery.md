# Disaster Recovery & Backup Strategy

## Overview

This document defines the disaster recovery (DR) plan for 0xSCADA deployments, including backup procedures, recovery targets, failover procedures, and data recovery steps.

## Recovery Objectives

| Metric | Target | Description |
|--------|--------|-------------|
| **RTO** (Recovery Time Objective) | 4 hours | Maximum time to restore service |
| **RPO** (Recovery Point Objective) | 1 hour | Maximum acceptable data loss |
| **MTTR** (Mean Time to Recovery) | 2 hours | Average recovery time |

## What Gets Backed Up

| Component | Method | Frequency | Retention |
|-----------|--------|-----------|-----------|
| PostgreSQL/TimescaleDB | `pg_dump` | Hourly | 30 days |
| Application config | File copy | Daily | 90 days |
| Blockchain state | Node snapshot | Daily | 14 days |
| TLS certificates | Encrypted archive | On rotation | 1 year |
| Audit logs | Append-only copy | Hourly | 1 year |

## Backup Procedures

### Automated Backups

Use `scripts/backup.sh`:
```bash
# Full backup
./scripts/backup.sh full

# Database only
./scripts/backup.sh database

# Config only
./scripts/backup.sh config
```

### Backup Storage

- **Primary**: Local encrypted storage (`/backups/`)
- **Secondary**: Remote S3-compatible bucket
- **Tertiary**: Offline/cold storage (monthly)

Encryption: AES-256 with key stored in HSM or Vault.

## Restore Procedures

Use `scripts/restore.sh`:
```bash
# Restore latest backup
./scripts/restore.sh latest

# Restore specific backup
./scripts/restore.sh /backups/2026-02-14_120000.tar.gz.enc

# Dry run (verify only)
./scripts/restore.sh --dry-run latest
```

## Failover Procedures

### Database Failover

1. Detect primary database failure (health check timeout >30s)
2. Promote read replica to primary
3. Update connection strings (via service discovery or config reload)
4. Verify data consistency
5. Alert operations team

### Application Failover

1. Load balancer detects unhealthy instance
2. Traffic routes to standby instance(s)
3. Standby connects to database and resumes operation
4. Scale replacement instances

### Blockchain Node Failover

1. Monitor detects validator offline (see `validator-health.ts`)
2. Standby validator node activates
3. Sync from latest snapshot + catch up
4. Resume block production

## Recovery Steps (Full Disaster)

1. **Assess** — Determine scope (single service, database, full site)
2. **Communicate** — Notify stakeholders, set expected RTO
3. **Infrastructure** — Provision replacement servers/containers
4. **Restore Database** — Run `scripts/restore.sh` with latest backup
5. **Restore Config** — Deploy application configuration
6. **Verify** — Run integration tests against restored environment
7. **Cutover** — Switch DNS/load balancer to restored environment
8. **Monitor** — Watch for 24h post-recovery

## Testing the DR Plan

- **Monthly**: Restore backup to staging, verify data integrity
- **Quarterly**: Full failover drill (simulate primary site loss)
- **Annually**: Review and update this document

## Contacts

| Role | Responsibility |
|------|---------------|
| On-call Engineer | First responder, executes runbook |
| Platform Lead | Escalation, decision authority |
| Security Lead | Assess if incident involves data breach |
