# PostgreSQL Connection Patterns

> Issue #21 — [Optix/Database] Implement PostgreSQL connection patterns

## Current Implementation

`server/db.ts` uses `pg.Pool` with Drizzle ORM:

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
```

## Enhanced Connection Pool

See `server/db/connection-pool.ts` for a production-ready pool with configurable sizing, health checks, metrics, and graceful shutdown.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DB_POOL_MIN` | `2` | Minimum idle connections |
| `DB_POOL_MAX` | `10` | Maximum connections |
| `DB_IDLE_TIMEOUT` | `30000` | Idle connection timeout (ms) |
| `DB_CONNECTION_TIMEOUT` | `5000` | Connection acquisition timeout (ms) |
| `DB_STATEMENT_TIMEOUT` | `30000` | Query execution timeout (ms) |

### Sizing Guidelines

| Workload | Min | Max |
|---|---|---|
| Development | 2 | 5 |
| Production (small) | 2 | 10 |
| Production (large) | 5 | 20 |
| Rule of thumb | — | `(CPU cores × 2) + disk spindles` |

---

## Query Patterns (Drizzle ORM)

### Select with Filters

```typescript
import { db } from '../db';
import { eventAnchors, sites, assets } from '@shared/schema';
import { eq, and, gte, desc } from 'drizzle-orm';

const recentEvents = await db.select().from(eventAnchors)
  .where(and(eq(eventAnchors.assetId, assetId), gte(eventAnchors.timestamp, since)))
  .orderBy(desc(eventAnchors.timestamp))
  .limit(100);
```

### Transaction

```typescript
await db.transaction(async (tx) => {
  const site = await tx.insert(sites).values({ name: 'Plant A', ... }).returning();
  await tx.insert(assets).values({ siteId: site[0].id, ... });
});
```

### Upsert

```typescript
await db.insert(controlModuleTypes)
  .values({ name: 'VSD_Motor', inputs: [...], outputs: [...] })
  .onConflictDoUpdate({
    target: controlModuleTypes.name,
    set: { inputs: sql`excluded.inputs`, outputs: sql`excluded.outputs` },
  });
```

---

## Migration Strategy

Using Drizzle Kit (configured in `drizzle.config.ts`):

```bash
npx drizzle-kit generate    # Generate migration from schema changes
npx drizzle-kit migrate     # Apply migrations
npx drizzle-kit push        # Push schema directly (dev only)
```

### Best Practices

- Never modify existing migrations
- Add columns as nullable first (avoid table locks)
- Use `CREATE INDEX CONCURRENTLY` for non-blocking index creation
- Test migrations on a copy before production
- Keep migrations small and focused

---

## Performance Tips

1. **Index** frequently queried columns (`assetId`, `timestamp`, `eventType`)
2. **Paginate** large result sets (already implemented: `getEventAnchorsPaginated`)
3. **Connection pool** — never create ad-hoc connections
4. **Batch inserts** for high-throughput event ingestion
5. **`EXPLAIN ANALYZE`** to debug slow queries
6. **Table partitioning** by time for event tables at scale
