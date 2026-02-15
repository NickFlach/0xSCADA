# Incident Response Playbook

## Severity Levels

| Level | Description | Response Time | Escalation |
|-------|-------------|---------------|------------|
| SEV-1 | Data loss, safety system failure | 5 min | Immediate page |
| SEV-2 | Major functionality degraded | 15 min | On-call engineer |
| SEV-3 | Minor functionality impacted | 1 hour | Next business day |
| SEV-4 | Cosmetic / low impact | 4 hours | Backlog |

## Response Steps

### 1. Acknowledge
- Claim the incident in the alerting system
- Join the incident channel
- Start the incident timer

### 2. Assess
- Check health dashboard: `/api/health`
- Review recent deployments and changes
- Identify affected components (gateway, server, historian, blockchain)
- Determine blast radius (number of tags/sites affected)

### 3. Mitigate
- Apply auto-remediation if available
- If gateway: check shard manager status, fail over to healthy nodes
- If database: initiate read-replica failover (see database-recovery.md)
- If network: verify federation heartbeats, enable store-and-forward

### 4. Communicate
- Update status page every 15 minutes for SEV-1/2
- Notify affected site operators
- Keep incident channel updated

### 5. Resolve
- Confirm metrics return to baseline
- Verify no data loss (Merkle root comparison)
- Stand down on-call escalation

### 6. Post-Mortem
- Schedule within 48 hours for SEV-1/2
- Use post-mortem template (see post-mortem-template.md)
- Track action items to completion

## SLO/SLI Definitions

| Service | SLI | SLO |
|---------|-----|-----|
| Tag reads | Latency p99 | < 100ms |
| Event ingestion | Availability | 99.9% |
| Alarm delivery | Latency p95 | < 500ms |
| Blockchain anchoring | Success rate | 99.5% |
| WebSocket connections | Availability | 99.9% |
| Historian queries | Latency p95 | < 2s |
