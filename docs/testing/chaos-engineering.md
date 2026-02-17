# Chaos Engineering Framework

## Overview

The chaos framework (`server/testing/chaos-framework.ts`) provides fault injection primitives for testing SCADA system resilience. **Only enable in non-production environments.**

## Experiment Types

| Type | Description |
|------|-------------|
| `network-delay` | Add latency to requests |
| `service-failure` | Return error responses |
| `resource-exhaustion` | Simulate CPU/memory/connection pressure |
| `connection-drop` | Drop connections randomly |

## Usage

```typescript
import { getChaosFramework } from '../server/testing/chaos-framework';

const chaos = getChaosFramework();
chaos.enable();

// Inject 200ms network delay on 50% of requests
chaos.injectNetworkDelay('api', { delayMs: 200, jitterMs: 50, percentage: 50 });

// Inject 503 errors on 10% of requests
chaos.injectServiceFailure('api', { statusCode: 503, percentage: 10 });

// Use as Express middleware
app.use(chaos.networkDelayMiddleware());
app.use(chaos.serviceFailureMiddleware());

// Stop all experiments
chaos.stopAll();
chaos.disable();
```

## Express Integration

```typescript
// Only enable in test/staging
if (process.env.CHAOS_ENABLED === 'true') {
  const chaos = getChaosFramework();
  chaos.enable();
  app.use(chaos.networkDelayMiddleware());
  app.use(chaos.serviceFailureMiddleware());
}
```

## Safety

- Framework is **disabled by default**
- Must explicitly call `chaos.enable()`
- Never enable in production
- `chaos.stopAll()` immediately removes all fault injection
- All experiments have IDs for targeted stop

## Event Hooks

```typescript
chaos.on('experiment:started', (exp) => console.log('Started:', exp.id));
chaos.on('experiment:stopped', (exp) => console.log('Stopped:', exp.id));
```
