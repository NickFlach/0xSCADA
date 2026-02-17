# Scaling Runbook

## When to Scale

| Indicator | Threshold | Action |
|-----------|-----------|--------|
| CPU utilization | > 70% sustained 15min | Add server instance |
| Memory utilization | > 80% | Add server instance or increase instance size |
| Tags per gateway | > 50,000 | Add gateway instance |
| Event queue depth | > 10,000 | Add pipeline workers |
| Query latency p95 | > 2s | Add historian replica |
| WebSocket connections | > 10,000 per server | Add server instance |

## Horizontal Scale-Out

### Adding a Gateway
1. Provision instance (see capacity-planning-guide.md for sizing)
2. Install gateway package, configure certificates
3. Register with shard manager: `POST /api/scaling/gateways`
4. Shard manager auto-rebalances within 60s
5. Verify tags migrating: `GET /api/scaling/shards?gateway={id}`

### Adding a Server Instance
1. Provision instance behind load balancer
2. Configure database connection, event pipeline consumer group
3. Add to load balancer pool: update LB config
4. Health check passes → traffic begins routing
5. Monitor for 15min, verify even distribution

### Adding Historian Capacity
1. Add new storage partition or read replica
2. Update partition config: `POST /api/historian/partitions`
3. Future writes go to new partition; reads federate across all

## Vertical Scale-Up
1. Snapshot current state
2. Drain connections: set node to `draining` in LB
3. Resize instance
4. Restore and restart
5. Re-enable in LB

## Scale-Down
1. Set node to `draining` in load balancer
2. Wait for drain timeout (default 30s)
3. Verify all connections migrated
4. Remove from shard manager / load balancer
5. Terminate instance
