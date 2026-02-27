# ADR-0015: Flux State Engine Integration

**Status:** Accepted  
**Date:** 2026-02-19  
**Deciders:** 0xSCADA Core Team, Arc (EckmanTechLLC), Kannaka (NickFlach)  
**References:** [ADR-0014 (Production Scale Architecture)](ADR-0014-production-scale-architecture.md), [Flux GitHub](https://github.com/EckmanTechLLC/flux), [Issue #260](https://github.com/NickFlach/0xSCADA/issues/260)

## Context

0xSCADA captures real-time SCADA telemetry, equipment state, and alerts. Currently this data lives within the platform's own storage and API layer. External systems — AI agents, dashboards, cross-platform coordinators — cannot observe SCADA state without direct API integration with 0xSCADA itself.

[Flux](https://github.com/EckmanTechLLC/flux) is a persistent, shared, event-sourced world state engine built in Rust (Axum + NATS/JetStream). It ingests immutable events, derives canonical in-memory entity state, and exposes it via REST and WebSocket APIs. Flux is domain-agnostic: any system that can HTTP POST can publish state, and any system can observe it. A production instance at `flux.eckman-tech.com` already carries live infrastructure data (VMs, PLCs, sensors, AI agents).

Integrating 0xSCADA with Flux would make SCADA state observable to any Flux-connected system without tight coupling. AI agents, other industrial platforms, and monitoring tools could observe equipment state through the same universal state layer they use for everything else.

This ADR was collaboratively authored by two AI agents (Arc and Kannaka) coordinating through Flux itself, with human review by Nick Flach and Matt Eckman.

## Decision

### 1. Entity Mapping Strategy

Map 0xSCADA equipment and sensors to Flux entities using the `scada/` namespace prefix:

| 0xSCADA Object | Flux Entity ID | Example |
|---|---|---|
| Equipment | `scada/{equipment-id}` | `scada/pump-01` |
| Sensor | `scada/{equipment-id}/{sensor-id}` | `scada/pump-01/flow-rate` |
| Site | `scada/site/{site-id}` | `scada/site/plant-north` |
| Alert | `scada/alert/{alert-id}` | `scada/alert/high-temp-reactor-3` |

Rationale: Flux natively supports `/` in entity IDs. The `scada/` prefix provides namespace isolation and allows Flux consumers to filter by prefix (supported since Flux Phase 3).

### 2. Telemetry/Control Entity Split

For entities that both publish sensor data AND accept remote commands, use **two separate entities**:

- `scada/pump-01` — telemetry (sensor readings, status, runtime)
- `scada/pump-01/control` — commands (setpoints, mode changes, actuations)

**Rationale:** Flux uses last-write-wins property merging. If a sensor publishing loop and a command writer target the same entity, the sensor loop can overwrite command properties before they are consumed. This was discovered in production with a Raspberry Pi Sense HAT where a 10-second sensor loop overwrote LED command properties. Splitting telemetry and control eliminates the race condition entirely without requiring read-merge-write patterns.

### 3. Event Publishing Pattern

Publish batched events at the 0xSCADA data collection layer, not per individual sensor reading:

```json
POST /api/events
{
  "stream": "scada",
  "source": "0xscada-instance-01",
  "timestamp": 1771543000000,
  "payload": {
    "entity_id": "scada/pump-01",
    "properties": {
      "status": "running",
      "flow_rate_gpm": 45.2,
      "pressure_psi": 32.1,
      "temperature_c": 28.5,
      "runtime_hours": 1247,
      "last_maintenance": "2026-01-15",
      "alert_active": false
    }
  }
}
```

For multiple entities updating simultaneously, use the batch endpoint:

```json
POST /api/events/batch
[
  {"stream": "scada", "source": "0xscada-instance-01", "timestamp": 1771543000000, "payload": {"entity_id": "scada/pump-01", "properties": {"flow_rate_gpm": 45.2}}},
  {"stream": "scada", "source": "0xscada-instance-01", "timestamp": 1771543000000, "payload": {"entity_id": "scada/pump-02", "properties": {"flow_rate_gpm": 38.7}}}
]
```

**Important:** The `timestamp` field must be epoch milliseconds (i64), not an ISO string.

Load testing has demonstrated Flux handling 300 events/second at 8% CPU on a 4-vCPU VM with room to scale further.

### 4. Command Property Protocol

For bidirectional control via the `/control` entity:

1. **Commander** publishes: `command`, `cmd_id` (unique per command), plus command-specific properties
2. **Executor** polls the control entity, detects new `cmd_id`, executes the command
3. **Executor** publishes acknowledgment: `cmd_ack`, `cmd_status` (accepted/rejected/completed/failed)

```json
// Command (written by agent or operator)
{"entity_id": "scada/pump-01/control", "properties": {"command": "set_speed", "cmd_id": "cmd-20260219-001", "target_rpm": 1200}}

// Acknowledgment (written by 0xSCADA)
{"entity_id": "scada/pump-01/control", "properties": {"cmd_ack": "cmd-20260219-001", "cmd_status": "completed"}}
```

### 5. Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `FLUX_URL` | Yes | — | Flux instance URL (e.g., `http://localhost:3000`) |
| `FLUX_AUTH_TOKEN` | No | — | Bearer token for namespaced Flux instances |
| `FLUX_PUBLISH_INTERVAL_MS` | No | `10000` | Minimum interval between entity updates |
| `FLUX_ENTITY_PREFIX` | No | `scada/` | Namespace prefix for all entities |
| `FLUX_STREAM` | No | `scada` | Event stream name |

## Consequences

### Positive
- SCADA state becomes observable by any Flux-connected system without 0xSCADA API coupling
- AI agents can monitor equipment, detect anomalies, and coordinate responses through shared world state
- The same pattern works for any Flux consumer: dashboards, other agents, cross-site coordinators
- Telemetry/control split eliminates property overwrite race conditions by design
- Batch publishing minimizes event volume while maintaining real-time visibility

### Negative
- Adds Flux as an optional external dependency (mitigated: Flux is optional, 0xSCADA functions without it)
- Requires network connectivity to Flux instance (mitigated: publish failures should be non-blocking with retry/backoff)
- Entity state is eventually consistent — Flux updates are near-real-time but not guaranteed synchronous

### Risks
- **Stale state:** If the publishing service crashes, Flux entities go stale silently. Recommend external staleness monitoring (already implemented in the Flux ecosystem via cron-based watchdog scripts).
- **Entity sprawl:** Large SCADA deployments could create thousands of Flux entities. Flux handles this well in-memory, but monitoring/UI may need prefix filtering.
