**File:** `server/services/optimization/correlation/correlation-graph.ts`

**Severity:** Low

**Problem:** `updateCorrelation()` creates adjacency entries and edges for sensors that were never registered via `addSensor()`. This means the graph can contain "ghost" sensors with edges but no metadata, and `getSensorIds()` won't return them. Example:

```typescript
graph.updateCorrelation('unknown-a', 'unknown-b', 0.8, 'proximity');
// adjacency has entries, edges exist, but sensors map is empty
graph.getSensorIds(); // returns [] — the sensors are invisible
graph.getCluster(0.5); // returns [] — ghost sensors not in sensors map
```

**Fix:** Either auto-register sensors in `updateCorrelation`, or throw/warn when updating correlations for unregistered sensors.
