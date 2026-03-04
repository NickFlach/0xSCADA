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
