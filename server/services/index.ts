/**
 * Services Barrel Export
 * 
 * Exports all service modules for centralized access.
 * This file consolidates all available services in the 0xSCADA system.
 * 
 * Issue: #282 — services/ barrel export missing modules
 */

// Boot singletons are bound statically, never through `import()`. On Node 20,
// tsx can hand a dynamic import a different module instance than the static
// consumers in server/routes.ts hold (#541) — the boot list would then report
// success while the routed singleton stayed uninitialized.
import { complianceService } from './compliance';
import { geometryService } from './geometry';
import { optimizationService } from './optimization';
import { spcService } from './spc';
import { alarmCorrelationService } from './alarm-correlation';
import { digitalTwinService } from './twin';
import { predictiveMaintenanceService } from './predictive';
import { tuningService } from './tuning';
import { marketplaceService } from './marketplace';
import { nlQueryService } from './nlquery';

// ── Verification Service ─────────────────────────────────────────────────────
export * from './verification';

// ── Governance Service ───────────────────────────────────────────────────────
// Re-export selectively to avoid name conflicts with integrity module
export * from './governance';

// ── Integrity Service ────────────────────────────────────────────────────────
// Some type names conflict with governance — use namespace import pattern
export {
  ParadoxResolver, paradoxResolver,
  createValveFlowConstraint, createPressureTemperatureConstraint,
  ExplainabilityMonitor, explainabilityMonitor,
} from './integrity';

// ── Vendors Service ──────────────────────────────────────────────────────────
export * from './vendors';

// ── Cache Service ────────────────────────────────────────────────────────────
export * from './cache';
export { getRedisClient, isRedisHealthy } from './cache';

// ── Compliance Service ───────────────────────────────────────────────────────
export * from './compliance';
export { complianceService } from './compliance';

// ── Capacity Planning Service (ADR-0014 [14.8], #228) ───────────────────────
export * from './capacity';

// ── Flux Service ─────────────────────────────────────────────────────────────
export * from './flux';

// ── SingularisPrime Integration ──────────────────────────────────────────────
export * from './singularis-prime';

// ── GR::LISTEN Alert Filtering ───────────────────────────────────────────────
export * from './gr-listen';

// ── Geometry Service ─────────────────────────────────────────────────────────
export * from './geometry';
export { geometryService } from './geometry';

// ── Machine Learning Service — REMOVED (#605) ────────────────────────────────
// `server/services/ml` was deleted, not disabled. Its inference path returned
// `Math.random()` draws as anomaly scores, maintenance scores and confidences,
// its "training" was `setTimeout(resolve, 2000)` followed by
// `accuracy = 0.85 + Math.random() * 0.1`, and its healthCheck() reported all
// of that as `healthy: true` because two hard-coded models were in a Map.
//
// #599 removed its only HTTP exposure, after which it had no consumer anywhere
// in the repo. What remained was a live symbol: `export * from './ml'`
// constructed the singleton at import time, `initializeServices()` listed it in
// the boot sequence, and `getServicesHealthStatus()` published it as a
// subsystem. (Neither of those two functions has a startup caller on `main` —
// see the notes in server/routes.ts — but both are exported, and a caller would
// have started a fabricator and then reported it healthy.) The service, its
// boot entry, its health key and its registry entry are all gone, so nothing
// can import `mlService` and mistake a PRNG for an inference backend.
//
// The /api/intelligence/ml/* routes stay 501 (server/routes/intelligence.ts).
// Reintroduce ML against a real model runtime, not before.

// ── Ubiquity Service — REMOVED (#638) ────────────────────────────────────────
// The deleted service registered hard-coded devices, treated endpoint strings
// as successful validation, and reported PRNG-driven command execution as real.
// The honest placeholder /api/ubiquity route remains until a real discovery and
// command backend is implemented.

// ── Optimization Service (PID Auto-Tuning & Decoherence Scheduler) ───────────
export * from './optimization';
export { optimizationService } from './optimization';

// ── Statistical Process Control Service ──────────────────────────────────────
export * from './spc';
export { spcService } from './spc';

// ── Predictive Maintenance Service (ADR-0013 [13.1], #212) ───────────────────
export * from './predictive';
export { predictiveMaintenanceService } from './predictive';

// ── Layer 2 Rollup Service — REMOVED (#638) ──────────────────────────────────
// The deleted service generated sequencer/L1 addresses, transaction hashes and
// submission outcomes locally, but had no consumer or blockchain backend.

// ── Digital Twin Service (ADR-0013 [13.3], #214) ─────────────────────────────
export * from './twin';
export { digitalTwinService } from './twin';
// ── Alarm Correlation Service (ADR-0013 [13.2], #213) ────────────────────────
export * from './alarm-correlation';
export { alarmCorrelationService } from './alarm-correlation';
// ── PID Tuning Service (ADR-0013 [13.4], #215) ───────────────────────────────
export * from './tuning';
export { tuningService } from './tuning';

// ── Intelligent Reporting (ADR-0013 [13.8], #219) ───────────────────────────
// The engine has no process-global singleton: historian, scheduler and delivery
// transports are injected by the deployment.
export * from './reporting';

// ── Agent Marketplace Service (ADR-0013 [13.6], #217) ────────────────────────
export * from './marketplace';
export { marketplaceService } from './marketplace';

// ── Production SRE Service (ADR-0014 [14.6], #226) ──────────────────────────
export * from './sre';

// ── NL Process Query Service (ADR-0013 [13.5], #216) ─────────────────────────
// Exported by name rather than with `export *`: the module's public surface
// includes generic bound names (MAX_RESULT_ITEMS, tokenize, ...) that would be
// ambiguous re-exports from a barrel this wide.
export { NLQueryService, nlQueryService } from './nlquery';

// ── ghostmagicOS Coordination (ADR-0013 [13.7], #218) ───────────────────────
// No singleton is exported: capability verification and the physical action
// executor are deployment-owned dependencies and must fail closed if absent.
export * from './ghostos';

/**
 * The lifecycle contract a service must satisfy to join the boot sequence.
 */
export interface ManagedService {
  initialize(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; message: string }>;
}

/**
 * One entry in the single startup path.
 */
export interface ManagedServiceEntry {
  /** Key this service occupies in the aggregate health surface. */
  readonly key: string;
  /** Operator-facing name written to the boot log. */
  readonly name: string;
  /** Directory under `server/services/` that implements it. */
  readonly module: string;
  /**
   * When true a failed `initialize()` aborts boot. Reserved for services where
   * serving traffic against un-hydrated state is a security defect rather than
   * a missing feature — these are the two that `registerRoutes` used to await
   * and propagate. The rest are logged and left unhealthy in
   * `getServicesHealthStatus()`, which is how an operator sees the failure
   * instead of the process dying on an unhandled rejection.
   */
  readonly required: boolean;
  readonly service: ManagedService;
}

/**
 * Every service the platform starts at boot, in dependency order.
 *
 * This list is the ONLY startup path (#10). `registerRoutes` keeps the
 * order-sensitive wiring that needs the HTTP server — evidence-collector
 * registration, `tagStreamServer.onTagUpdate(...)` ingest hooks and
 * `httpServer.once("close", ...)` shutdown handlers — but calls no
 * `initialize()` of its own.
 *
 * 'Machine Learning' was removed (#605) — the service it booted fabricated its
 * output; see the removal note above. Ubiquity and L2 Rollup are removed
 * (#638); neither may be started by this generic boot sequence.
 */
export const MANAGED_SERVICES: readonly ManagedServiceEntry[] = [
  // Required: registerRoutes hands compliance the deployment's evidence
  // collectors first, and a scan that ran without them would report an
  // unevidenced "compliant".
  {
    key: 'compliance',
    name: 'Compliance',
    module: 'compliance',
    required: true,
    service: complianceService,
  },
  { key: 'geometry', name: 'Geometry', module: 'geometry', required: false, service: geometryService },
  // Optimization owns the PID controller registry that tuning proposes
  // against, so it is started before PID Tuning.
  {
    key: 'optimization',
    name: 'Optimization',
    module: 'optimization',
    required: false,
    service: optimizationService,
  },
  { key: 'spc', name: 'SPC', module: 'spc', required: false, service: spcService },
  {
    key: 'alarmCorrelation',
    name: 'Alarm Correlation',
    module: 'alarm-correlation',
    required: false,
    service: alarmCorrelationService,
  },
  { key: 'twin', name: 'Digital Twin', module: 'twin', required: false, service: digitalTwinService },
  {
    key: 'predictive',
    name: 'Predictive Maintenance',
    module: 'predictive',
    required: false,
    service: predictiveMaintenanceService,
  },
  { key: 'tuning', name: 'PID Tuning', module: 'tuning', required: false, service: tuningService },
  // Required: the publish path checks plugin ownership against the loaded
  // registry, and an ownership check against an un-hydrated registry would
  // authorize a hijack.
  {
    key: 'marketplace',
    name: 'Agent Marketplace',
    module: 'marketplace',
    required: true,
    service: marketplaceService,
  },
  // Reads the alarm-correlation engine at query time, so it is marked live
  // after that engine is running.
  {
    key: 'nlquery',
    name: 'NL Process Query',
    module: 'nlquery',
    required: false,
    service: nlQueryService,
  },
];

/**
 * Initialize every service in `MANAGED_SERVICES`, in order.
 *
 * Called exactly once, by `server/index.ts`, after `registerRoutes` has
 * installed the order-sensitive wiring and before the HTTP listener opens.
 */
export async function initializeServices(): Promise<void> {
  for (const entry of MANAGED_SERVICES) {
    try {
      await entry.service.initialize();
      console.log(`✓ ${entry.name} service initialized`);
    } catch (error) {
      console.error(`✗ Failed to initialize ${entry.name} service:`, error);
      if (entry.required) throw error;
      // Continue with other services even if an optional one fails; the
      // aggregate health surface reports it as unhealthy.
    }
  }
}

/**
 * Aggregate health for every service in the single startup path.
 *
 * The keys are exactly the keys of `MANAGED_SERVICES` — a service that is
 * booted is reported on, and nothing else is. Redis/cache health is reported
 * by `server/health/` under `redis`; it is not started by this path, so it is
 * not claimed here. The former `flux` entry returned a hard-coded
 * `healthy: true` from a try block that could not throw, which asserted
 * nothing about the integration, and is gone.
 */
export async function getServicesHealthStatus(): Promise<{
  [serviceName: string]: { healthy: boolean; message: string };
}> {
  const results: { [key: string]: { healthy: boolean; message: string } } = {};

  await Promise.all(
    MANAGED_SERVICES.map(async (entry) => {
      try {
        const { healthy, message } = await entry.service.healthCheck();
        results[entry.key] = { healthy, message };
      } catch (error) {
        results[entry.key] = {
          healthy: false,
          message: error instanceof Error
            ? error.message
            : `${entry.name} service not available`,
        };
      }
    }),
  );

  return results;
}

/**
 * Service registry for dynamic access
 */
export const serviceRegistry = {
  cache: () => import('./cache'),
  compliance: () => import('./compliance'),
  capacity: () => import('./capacity'),
  flux: () => import('./flux'),
  geometry: () => import('./geometry'),
  optimization: () => import('./optimization'),
  spc: () => import('./spc'),
  sre: () => import('./sre')
} as const;

export type ServiceName = keyof typeof serviceRegistry;
