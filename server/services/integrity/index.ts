/**
 * Integrity Services
 * 
 * Paradox resolution and explainability monitoring for SCADA systems.
 */

export { ParadoxResolver, paradoxResolver } from './paradox-resolver';
export type {
  ScadaEvent,
  ConflictDetection,
  ConflictType,
  Resolution,
  ResolutionMethod,
  ResolvedEvent,
  RollbackPlan,
  PhysicsConstraint,
  PhysicsValidationResult,
  ProcessAreaRules,
  ParadoxResolverConfig,
} from './paradox-resolver';
export {
  createValveFlowConstraint,
  createPressureTemperatureConstraint,
} from './paradox-resolver';

export { ExplainabilityMonitor, explainabilityMonitor } from './explainability-monitor';
export type {
  DecisionRecord,
  VerificationLayerResult,
  ElectronicSignature,
  AuditEntry,
  ComplianceCheck,
  Explanation,
  ComplianceReport,
  ComplianceReportFinding,
  ComplianceReportSection,
  GovernanceGate,
  GovernanceCheckResult,
  VerificationHook,
  ExplainabilityConfig,
} from './explainability-monitor';

// Evolutionary resolution + composition root (#492)
export { EvolutionaryResolver } from './evolutionary/evolutionary-resolver';
export type {
  EvolutionaryResolverConfig,
  EvolutionaryResolution,
  EvolutionaryResolverStatus,
} from './evolutionary/evolutionary-resolver';
export { IntegrityService, integrityService } from './integrity-service';
export type { IntegrityServiceConfig, IngestOutcome } from './integrity-service';
