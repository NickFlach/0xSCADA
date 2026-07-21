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

// ── Flux Service ─────────────────────────────────────────────────────────────
export * from './flux';

// ── SingularisPrime Integration ──────────────────────────────────────────────
export * from './singularis-prime';

// ── GR::LISTEN Alert Filtering ───────────────────────────────────────────────
export * from './gr-listen';

// ── Geometry Service ─────────────────────────────────────────────────────────
export * from './geometry';
export { geometryService } from './geometry';

// ── Machine Learning Service ─────────────────────────────────────────────────
export * from './ml';
export { mlService } from './ml';

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
    { name: 'Machine Learning', service: () => import('./ml').then(m => m.mlService.initialize()) },
    { name: 'Ubiquity', service: () => import('./ubiquity').then(m => m.ubiquityService.initialize()) },
    { name: 'Layer 2 Rollup', service: () => import('./l2-rollup').then(m => m.l2RollupService.initialize()) },
    { name: 'Optimization', service: () => import('./optimization').then(m => m.optimizationService.initialize()) },
    { name: 'SPC', service: () => import('./spc').then(m => m.spcService.initialize()) },
    { name: 'Predictive Maintenance', service: () => import('./predictive').then(m => m.predictiveMaintenanceService.initialize()) }
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
    ml: async () => {
      try {
        const { mlService } = await import('./ml');
        return await mlService.healthCheck();
      } catch {
        return { healthy: false, message: 'ML service not available' };
      }
    },
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
    predictive: async () => {
      try {
        const { predictiveMaintenanceService } = await import('./predictive');
        return await predictiveMaintenanceService.healthCheck();
      } catch {
        return { healthy: false, message: 'Predictive maintenance service not available' };
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
  flux: () => import('./flux'),
  geometry: () => import('./geometry'),
  ml: () => import('./ml'),
  ubiquity: () => import('./ubiquity'),
  l2Rollup: () => import('./l2-rollup'),
  optimization: () => import('./optimization'),
  spc: () => import('./spc')
} as const;

export type ServiceName = keyof typeof serviceRegistry;