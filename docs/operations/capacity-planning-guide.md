# Capacity Planning Guide — 0xSCADA

## Quick Reference

| Tag Count | Tier | Gateways | Servers | CPU Cores | Memory | Storage (90d) |
|-----------|------|----------|---------|-----------|--------|---------------|
| 1,000 | Starter | 1 | 1 | 1 | 1 GB | 10 GB |
| 10,000 | Starter | 1 | 1 | 1 | 1 GB | 10 GB |
| 50,000 | Professional | 1 | 1 | 3 | 1 GB | 43 GB |
| 100,000 | Professional | 2 | 1 | 5 | 1 GB | 86 GB |
| 500,000 | Enterprise | 10 | 5 | 25 | 1 GB | 429 GB |
| 1,000,000 | Hyperscale | 20 | 10 | 50 | 2 GB | 858 GB |

## Resource Estimation

Per tag (approximate):
- **CPU:** 0.05 millicores
- **Memory:** 2 KB
- **Storage:** 10 KB/day (historian)
- **Bandwidth:** 50 bytes/sec (average, bidirectional)

## Cloud Cost Estimates (Monthly, USD)

| Tag Count | AWS | Azure | GCP |
|-----------|-----|-------|-----|
| 10,000 | ~$150 | ~$150 | ~$145 |
| 100,000 | ~$450 | ~$445 | ~$460 |
| 500,000 | ~$2,200 | ~$2,150 | ~$2,250 |
| 1,000,000 | ~$4,400 | ~$4,300 | ~$4,500 |

_Costs include compute, storage (90-day retention), and network egress. Actual costs vary._

## Scaling Strategy

### Starter (< 10k tags)
- Single gateway, single server
- SQLite or PostgreSQL
- No sharding needed
- Store-and-forward for edge resilience

### Professional (10k–100k tags)
- 1–2 gateways with shard manager
- PostgreSQL with time partitioning
- Load balancer for API/WebSocket
- Automated benchmarking enabled

### Enterprise (100k–500k tags)
- Sharded gateways (1 per 50k tags)
- Distributed historian with partitioning
- Multi-site federation
- Full compliance toolkit
- SRE playbooks and auto-remediation

### Hyperscale (500k+ tags)
- 10+ sharded gateways
- Horizontally scaled servers
- Multi-region federation
- Dedicated monitoring infrastructure
- Custom capacity planning engagement

## Growth Forecasting

Use `CapacityPlanner.forecastGrowth()` to project tag count growth based on historical data. Plan capacity 6 months ahead of projected need.

## Cost Optimization

1. **Right-size instances** — Use capacity planner recommendations
2. **Reserved instances** — 1-year commitment saves 30-40%
3. **Storage tiering** — Hot (30d) / Warm (90d) / Cold (1yr+)
4. **Network optimization** — Compress historian data, batch WebSocket updates
5. **Spot instances** — For non-critical batch processing (benchmarks, reports)
