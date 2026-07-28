/**
 * Services Barrel Export
 * 
 * Exports all service modules for centralized access.
 * This file consolidates all available services in the 0xSCADA system.
 * 
 * Issue: #282 — services/ barrel export missing modules
 */

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

// ── Ubiquity Service ─────────────────────────────────────────────────────────
export * from './ubiquity';
export { ubiquityService } from './ubiquity';

// ── Optimization Service (PID Auto-Tuning & Decoherence Scheduler) ───────────
export * from './optimization';
export { optimizationService } from './optimization';

// ── Statistical Process Control Service ──────────────────────────────────────
export * from './spc';
export { spcService } from './spc';

// ── Predictive Maintenance Service (ADR-0013 [13.1], #212) ───────────────────
export * from './predictive';
export { predictiveMaintenanceService } from './predictive';

// ── Layer 2 Rollup Service ───────────────────────────────────────────────────
export * from './l2-rollup';
export { l2RollupService } from './l2-rollup';

// ── Digital Twin Service (ADR-0013 [13.3], #214) ─────────────────────────────
export * from './twin';
export { digitalTwinService } from './twin';
// ── Alarm Correlation Service (ADR-0013 [13.2], #213) ────────────────────────
export * from './alarm-correlation';
export { alarmCorrelationService } from './alarm-correlation';
// ── PID Tuning Service (ADR-0013 [13.4], #215) ───────────────────────────────
export * from './tuning';
export { tuningService } from './tuning';

// ── Agent Marketplace Service (ADR-0013 [13.6], #217) ────────────────────────
export * from './marketplace';
export { marketplaceService } from './marketplace';

// ── NL Process Query Service (ADR-0013 [13.5], #216) ─────────────────────────
// Exported by name rather than with `export *`: the module's public surface
// includes generic bound names (MAX_RESULT_ITEMS, tokenize, ...) that would be
// ambiguous re-exports from a barrel this wide.
export { NLQueryService, nlQueryService } from './nlquery';

// ── ghostmagicOS Coordination (ADR-0013 [13.7], #218) ───────────────────────
// No singleton is exported: capability verification and the physical action
// executor are deployment-owned dependencies and must fail closed if absent.
export * from './ghostos';
// ── Intelligent Reporting (ADR-0013 [13.8], #219) ───────────────────────────
// The engine has no process-global singleton: historian, scheduler and delivery
// transports are injected by the deployment.
export * from './reporting';

/**
 * Initialize all services
 * 
 * Call this function to initialize all services in the correct order.
 * Some services may depend on others being initialized first.
 */
export async function initializeServices(): Promise<void> {
  const services = [
    { name: 'Compliance', service: () => import('./compliance').then(m => m.complianceService.initialize()) },
    { name: 'Geometry', service: () => import('./geometry').then(m => m.geometryService.initialize()) },
    // 'Machine Learning' removed (#605) — the service it booted fabricated its
    // output; see the removal note above.
    { name: 'Ubiquity', service: () => import('./ubiquity').then(m => m.ubiquityService.initialize()) },
    { name: 'Layer 2 Rollup', service: () => import('./l2-rollup').then(m => m.l2RollupService.initialize()) },
    { name: 'Optimization', service: () => import('./optimization').then(m => m.optimizationService.initialize()) },
    { name: 'SPC', service: () => import('./spc').then(m => m.spcService.initialize()) },
    { name: 'Digital Twin', service: () => import('./twin').then(m => m.digitalTwinService.initialize()) },
    { name: 'Predictive Maintenance', service: () => import('./predictive').then(m => m.predictiveMaintenanceService.initialize()) },
    { name: 'PID Tuning', service: () => import('./tuning').then(m => m.tuningService.initialize()) },
    { name: 'Agent Marketplace', service: () => import('./marketplace').then(m => m.marketplaceService.initialize()) }
  ];

  for (const { name, service } of services) {
    try {
      await service();
      console.log(`✓ ${name} service initialized`);
    } catch (error) {
      console.error(`✗ Failed to initialize ${name} service:`, error);
      // Continue with other services even if one fails
    }
  }
}

/**
 * Get health status for all services
 */
export async function getServicesHealthStatus(): Promise<{
  [serviceName: string]: { healthy: boolean; message: string };
}> {
  const healthChecks = {
    cache: async () => {
      try {
        const { isRedisHealthy } = await import('./cache');
        return { healthy: isRedisHealthy(), message: isRedisHealthy() ? 'Cache healthy' : 'Cache unavailable' };
      } catch {
        return { healthy: false, message: 'Cache service error' };
      }
    },
    compliance: async () => {
      try {
        const { complianceService } = await import('./compliance');
        return await complianceService.healthCheck();
      } catch {
        return { healthy: false, message: 'Compliance service not available' };
      }
    },
    flux: async () => {
      try {
        // Flux health would depend on connection status
        return { healthy: true, message: 'Flux integration healthy' };
      } catch {
        return { healthy: false, message: 'Flux service error' };
      }
    },
    geometry: async () => {
      try {
        const { geometryService } = await import('./geometry');
        return await geometryService.healthCheck();
      } catch {
        return { healthy: false, message: 'Geometry service not available' };
      }
    },
    // No `ml` key (#605). The removed check reported `healthy: true` whenever
    // two hard-coded models were present, which said nothing about whether
    // anything could infer — there was no inference. An absent key is the
    // honest answer: the platform has no ML subsystem to report on.
    ubiquity: async () => {
      try {
        const { ubiquityService } = await import('./ubiquity');
        return await ubiquityService.healthCheck();
      } catch {
        return { healthy: false, message: 'Ubiquity service not available' };
      }
    },
    l2Rollup: async () => {
      try {
        const { l2RollupService } = await import('./l2-rollup');
        return await l2RollupService.healthCheck();
      } catch {
        return { healthy: false, message: 'L2 Rollup service not available' };
      }
    },
    optimization: async () => {
      try {
        const { optimizationService } = await import('./optimization');
        return await optimizationService.healthCheck();
      } catch {
        return { healthy: false, message: 'Optimization service not available' };
      }
    },
    spc: async () => {
      try {
        const { spcService } = await import('./spc');
        return await spcService.healthCheck();
      } catch {
        return { healthy: false, message: 'SPC service not available' };
      }
    },
    twin: async () => {
      try {
        const { digitalTwinService } = await import('./twin');
        return await digitalTwinService.healthCheck();
      } catch {
        return { healthy: false, message: 'Digital twin service not available' };
      }
    },
    predictive: async () => {
      try {
        const { predictiveMaintenanceService } = await import('./predictive');
        return await predictiveMaintenanceService.healthCheck();
      } catch {
        return { healthy: false, message: 'Predictive maintenance service not available' };
      }
    },
    tuning: async () => {
      try {
        const { tuningService } = await import('./tuning');
        return await tuningService.healthCheck();
      } catch {
        return { healthy: false, message: 'Tuning service not available' };
      }
    },
    marketplace: async () => {
      try {
        const { marketplaceService } = await import('./marketplace');
        return await marketplaceService.healthCheck();
      } catch {
        return { healthy: false, message: 'Marketplace service not available' };
      }
    }
  };

  const results: { [key: string]: { healthy: boolean; message: string } } = {};

  await Promise.allSettled(
    Object.entries(healthChecks).map(async ([name, check]) => {
      try {
        results[name] = await check();
      } catch (error) {
        results[name] = { 
          healthy: false, 
          message: error instanceof Error ? error.message : 'Unknown error' 
        };
      }
    })
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
  ubiquity: () => import('./ubiquity'),
  l2Rollup: () => import('./l2-rollup'),
  optimization: () => import('./optimization'),
  spc: () => import('./spc')
} as const;

export type ServiceName = keyof typeof serviceRegistry;
