# Database Recovery Playbook

## Symptoms
- Historian queries failing or timing out
- `HealthManager` reporting database unhealthy
- Event pipeline backing up (store-and-forward activating)

## Diagnostic Steps

1. **Check database connectivity**
   ```bash
   curl http://localhost:3000/api/health | jq '.database'
   ```

2. **Check disk space**
   ```bash
   df -h /var/lib/0xscada/data
   ```

3. **Check active connections**
   ```bash
   # PostgreSQL
   SELECT count(*) FROM pg_stat_activity;
   ```

## Recovery Procedures

### Connection Pool Exhaustion
1. Restart connection pool: `POST /api/admin/db/pool/reset`
2. Check for long-running queries and terminate
3. Increase pool size if recurring

### Corrupted Data Partition
1. Identify affected time partition
2. Verify Merkle root against blockchain anchor
3. Restore from last known-good snapshot
4. Replay events from store-and-forward queue
5. Verify integrity: compare Merkle roots

### Full Database Failover
1. Promote read replica to primary
2. Update connection strings via feature flag
3. Verify write capability
4. Rebuild replica from new primary
5. Update DNS/load balancer targets

### Data Loss Verification
1. Compare local Merkle root with blockchain-anchored root
2. If mismatch: identify divergence point
3. Replay from store-and-forward or federation peers
4. Document in post-mortem

## Prevention
- Monitor disk usage alerts at 80% threshold
- Automated partition pruning per retention policy
- Regular backup verification (weekly)
