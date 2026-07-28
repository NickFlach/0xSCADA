# ghostmagicOS coordination

Issue [#218](https://github.com/NickFlach/0xSCADA/issues/218) implements the
ADR-0013 Signal → Resonance → Emergence model as an executable coordination
service.

## Runtime model

- **Signal** is a finite numeric event accepted from the canonical
  `EventPipeline`. `defaultPipelineSignalMapper` recognizes a primitive numeric
  payload or the common `value`, `tagValue`, and `reading` fields. Duplicate
  source/sequence identifiers are rejected.
- **Resonance** is a Pearson correlation across timestamp-aligned source
  buckets. Detection has configurable sample and strength thresholds, stable
  source ordering, bounded retention, and duplicate-window suppression.
- **Emergence** is an action recommendation tied to a detected resonance
  pattern. It is not an execution permission.

Agent phases use a simultaneous forward-Euler Kuramoto step:

```text
d(theta_i)/dt = omega_i + K_i/N * sum(sin(theta_j - theta_i))
```

The bridge reports the standard order parameter `r` (coherence) and circular
mean phase `psi`. Initial phases are derived from the agent ID unless explicitly
provided, so replaying the same inputs and clock produces the same state.

## Pipeline and orchestrator integration

```ts
import { getDefaultEventPipeline } from "../../server/pipeline/event-pipeline";
import {
  GhostOSOrchestrator,
  InMemoryCapabilityAuthorizer,
} from "../../server/services/ghostos";

const capabilities = new InMemoryCapabilityAuthorizer();
// Capability grants should normally come from the deployment's signed-token
// verifier. The in-memory implementation is useful for a local trusted setup.

const orchestrator = new GhostOSOrchestrator({
  capabilityAuthorizer: capabilities,
  executor: {
    async execute(decision) {
      // This is the only physical/workflow output boundary. Adapt it to a
      // separately authenticated plant command service.
      return commandService.dispatch(decision.action);
    },
  },
});

const detach = orchestrator.attachPipeline(getDefaultEventPipeline());
// Call detach() during shutdown.
```

The orchestrator may also accept a deployment-specific `PipelineSignalMapper`.
It never subscribes to raw field protocols or creates a parallel telemetry
path.

## Safety contract

Each registered agent has an `OperationalEnvelope` covering:

- allowed and forbidden action targets;
- allowed action kinds;
- minimum recommendation confidence and multi-agent coherence;
- maximum setpoint change and recommendation age;
- execution rate limit; and
- required independent human approvals.

The lifecycle uses separate, time-bounded capability checks:

```text
recommend:<kind> -> approve:<kind> -> actuate:<kind> / execute:<kind>
```

An agent cannot approve its own recommendation. Approval requires an
`AuthenticatedPrincipal`; HTTP adapters must derive that principal from
`controlPlanePrincipal(req)`, never from a request body. Control and
configuration actions use `actuate:*`; notification and workflow actions use
`execute:*`.

The envelope and coherence are checked again immediately before dispatch.
Missing capability service, missing executor, expired recommendation, dropped
coherence, exhausted rate limit, or any envelope violation fails closed. The
default envelope forbids all targets and the default authorizer denies every
capability.

There is intentionally no unauthenticated REST mount. A deployment that adds
one must bind identity through the control-plane middleware and persist its
approval/audit state before exposing remote actuation.

## Observability

`GhostOSOrchestrator` emits immutable `audit` and `decision` events. Its
sequence-numbered audit trail covers accepted/rejected signals, detected
resonance, registration and synchronization, recommendation, blocked and
denied decisions, approvals, execution, and errors. `getStatus()` provides
bounded counts, coherence, decision states, and whether an executor is
configured.

Primary imports use `server/services/ghostos`. The historical
`server/intelligence/ghostos-bridge.ts` path remains as a compatibility export.
