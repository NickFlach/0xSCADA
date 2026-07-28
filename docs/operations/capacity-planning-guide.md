# Capacity Planning and Cost Modeling

The `CapacityPlanner` turns a tag workload into resource, topology, growth, and
cloud-cost projections. All coefficients and rate cards are versioned and
returned by `GET /api/governance/capacity/model`; projections are planning
estimates, not cloud-provider quotes.

## Required workload inputs

| Field | Default | Meaning |
|---|---:|---|
| `tagCount` | required | Current configured tag count |
| `sampleIntervalSeconds` | 1 | Average acquisition interval |
| `retentionDays` | 90 | Online historian retention |
| `headroomPercent` | 30 | Reserve applied to resources and topology |
| `highAvailability` | true | Enforce at least two gateway and API instances |
| `historianCopies` | 1 | Retained data copies, including replicas |
| `subscriberFanout` | 1 | Average delivered subscriber copies per update |

The default per-tag coefficients at a one-second interval are:

- CPU: 0.05 millicores;
- resident memory: 2 KiB;
- historian storage: 10 KiB/day;
- ingress: 50 bytes/second;
- egress: 50 bytes/second multiplied by subscriber fan-out.

CPU, storage, and bandwidth scale inversely with sample interval. Resident tag
memory does not. Total resource estimates add a base service allocation and the
requested headroom. Topology limits are 50,000 tags per gateway, 100,000 tags
per API server, and 250,000 tags per historian shard before headroom.

## Generate a complete plan

```http
POST /api/governance/capacity/plan
Content-Type: application/json

{
  "workload": {
    "tagCount": 125000,
    "sampleIntervalSeconds": 1,
    "retentionDays": 180,
    "headroomPercent": 35,
    "historianCopies": 2,
    "subscriberFanout": 0.25
  },
  "history": [
    { "timestamp": "2026-01-01T00:00:00.000Z", "tagCount": 90000 },
    { "timestamp": "2026-02-01T00:00:00.000Z", "tagCount": 98000 },
    { "timestamp": "2026-03-01T00:00:00.000Z", "tagCount": 107000 },
    { "timestamp": "2026-04-01T00:00:00.000Z", "tagCount": 116000 },
    { "timestamp": "2026-05-01T00:00:00.000Z", "tagCount": 125000 }
  ],
  "horizonMonths": 6,
  "providers": ["aws", "azure", "gcp"]
}
```

The response contains:

- `current`: resources and topology for the current workload;
- `forecast`: least-squares growth trend, fit quality, and confidence;
- `planning`: resources for the greater of current and forecast tag count;
- `cloudCosts`: itemized compute, storage, egress, and load-balancer costs;
- `scaling`: cost-optimized, balanced, and performance alternatives.

The older root-level workload fields and `constraints.tagCount` are accepted for
compatibility. A request without tag count fails; the API does not substitute
placeholder usage.

## Cloud-cost assumptions

The built-in AWS, Azure, and GCP cards are reference on-demand rates identified
by version and region. Cost calculations use:

1. the greater of CPU- or memory-required node count at target utilization;
2. the minimum node count required by the planned topology;
3. 730 compute hours per month;
4. billable retained GiB;
5. modeled subscriber egress GiB;
6. one load balancer for an HA workload.

Taxes, support plans, negotiated/committed-use discounts, managed-service
premiums, inter-zone transfer, and backup API charges are excluded. Production
financial review should construct `CapacityPlanner` with the organization's
contracted `CloudRateCard` values.

## Growth forecast

`forecastGrowth(history, horizonMonths)` fits tag count against elapsed days
using linear least squares. It returns slope, R², monthly and annualized growth,
and the projected horizon count.

Confidence is:

- high: at least six points over 90 days with R² ≥ 0.8;
- medium: at least three points over 30 days with R² ≥ 0.5;
- low: anything less.

Low confidence selects additional performance reserve. Forecasts may project a
decline, but capacity planning never sizes below the current tag count.

Use `POST /api/governance/capacity/forecast` when only a forecast is required.
Retain raw historical points with the plan so reviewers can reproduce it.

## Scaling trade-offs

| Strategy | Headroom | Best use | Trade-off |
|---|---:|---|---|
| Cost optimized | 20% | Stable, high-confidence workloads | Lowest cost; least burst/failover reserve |
| Balanced | 35% | Normal production OT workloads | Moderate reserve and spend |
| Performance | 60% | Fast growth or uncertain forecast | Most resilience; highest idle cost |

Every strategy preserves the workload's HA setting and shows monthly cost for
all requested providers. Default scale triggers are 70% tags-per-gateway, 70%
CPU, 75% memory, and 70% storage so provisioning can complete before exhaustion.

## Operational review checklist

Before approving a plan:

1. validate tag count and sample intervals from observed inventory;
2. include burst and alarm-storm fan-out, not only daily averages;
3. choose historian copy count from the recovery policy;
4. review data-sovereignty and provider-region constraints;
5. replace reference prices with contracted prices;
6. load-test the planned topology;
7. schedule a monthly forecast refresh and trigger an immediate refresh after a
   site acquisition, retention change, or large tag import.
