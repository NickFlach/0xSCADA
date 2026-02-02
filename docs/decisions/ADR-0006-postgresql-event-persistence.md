# ADR-0006: PostgreSQL for Event Persistence

## Status

Accepted

## Date

2024-01-28

## Context

0xSCADA generates multiple categories of persistent data:

1. **Time-Series Telemetry**: High-frequency sensor readings (handled separately)
2. **Events**: Alarms, state changes, operator actions
3. **Configuration**: System settings, device registrations
4. **Audit Logs**: Who did what, when (blockchain-backed)
5. **Metadata**: Tags, relationships, documentation

Requirements for event persistence:
- ACID transactions for data integrity
- Complex queries (joins, aggregations, filtering)
- Reliable replication for high availability
- Strong ecosystem and tooling
- Reasonable performance at scale

## Decision

We use **PostgreSQL** as the primary relational database:

1. **Schema Design**:
   ```sql
   -- Core event table
   CREATE TABLE events (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     event_type VARCHAR(50) NOT NULL,
     severity INTEGER NOT NULL,
     source_id UUID REFERENCES devices(id),
     payload JSONB NOT NULL,
     merkle_root BYTEA,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );

   -- Indexes for common queries
   CREATE INDEX idx_events_type ON events(event_type);
   CREATE INDEX idx_events_time ON events(created_at);
   CREATE INDEX idx_events_source ON events(source_id);
   CREATE INDEX idx_events_payload ON events USING GIN(payload);
   ```

2. **Features Utilized**:
   - **JSONB**: Flexible schema for event payloads
   - **Partitioning**: Time-based partitions for archival
   - **Streaming Replication**: High availability setup
   - **LISTEN/NOTIFY**: Real-time event notifications
   - **Full-Text Search**: Log analysis capabilities

3. **Integration Points**:
   - TimescaleDB extension for time-series (telemetry)
   - pgcrypto for hashing/verification
   - pg_cron for maintenance jobs
   - Logical replication to analytics systems

4. **Operational Configuration**:
   - Connection pooling via PgBouncer
   - Automated backups with WAL archiving
   - Monitoring via pg_stat_statements

## Consequences

### Positive

- **Mature and reliable**: 25+ years of production hardening
- **ACID compliance**: Strong data integrity guarantees
- **Rich feature set**: JSONB, FTS, extensions ecosystem
- **Excellent tooling**: pgAdmin, psql, extensive monitoring
- **Strong community**: Abundant documentation and support

### Negative

- **Scaling limits**: Single-node write bottleneck
- **Operational overhead**: Requires DBA expertise for tuning
- **Schema migrations**: Need careful planning for changes
- **Resource intensive**: Higher memory/CPU than lighter DBs

### Neutral

- Industry standard for relational data
- Good cloud offerings (RDS, Cloud SQL, etc.)
- TimescaleDB integration proven at scale

## Alternatives Considered

### Alternative 1: MongoDB

Document database with flexible schema.

Rejected because: Weaker consistency guarantees, less mature for complex queries, and we don't need the extreme flexibility for our structured events.

### Alternative 2: MySQL/MariaDB

Alternative relational database.

Rejected because: JSONB support less mature, fewer advanced features, and PostgreSQL has better extension ecosystem.

### Alternative 3: ClickHouse

Column-oriented analytics database.

Rejected because: Optimized for analytics, not OLTP workloads; poor for transactional event insertion.

### Alternative 4: CockroachDB

Distributed SQL database.

Rejected because: Adds operational complexity of distributed system; PostgreSQL replication sufficient for our scale.

## References

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [TimescaleDB Extension](https://www.timescale.com/)
- [PgBouncer Connection Pooler](https://www.pgbouncer.org/)
- [ADR-0001: Hybrid Architecture](ADR-0001-hybrid-on-off-chain-architecture.md)
