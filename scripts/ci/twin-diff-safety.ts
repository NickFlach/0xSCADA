#!/usr/bin/env npx tsx
/**
 * 0xSCADA Twin Diff Safety Check Script
 * 
 * VERITY Architecture - γ.3: Artifact-First CI/CD
 * 
 * Compares proposed twin state against safety envelopes to ensure
 * code changes don't introduce unsafe operational configurations.
 * 
 * "GitHub PRs for industrial reality."
 * "diff twin-snapshot-a twin-snapshot-b before approving change"
 * 
 * Usage:
 *   npx tsx scripts/ci/twin-diff-safety.ts --base-twin main.json --head-twin proposed.json
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";

// Import types from shared
import type { ContentHash } from "../../shared/artifact";
import type { 
  TwinCheckpoint, 
  CheckpointState,
  CheckpointDiff,
  SafetyConstraint,
  PLCState,
  AlarmThreshold,
  CalibrationRecord,
} from "../../shared/types/twin-checkpoint";

// =============================================================================
// CLI ARGUMENT PARSING
// =============================================================================

const { values: args } = parseArgs({
  options: {
    "twins-dir": { type: "string", default: ".artifacts/twins" },
    "base-twin": { type: "string", default: "" },
    "head-twin": { type: "string", default: "" },
    "output-file": { type: "string", default: "twin-safety-results.json" },
    "fail-on-critical": { type: "boolean", default: true },
    "fail-on-high": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`
0xSCADA Twin Diff Safety Check Script

Compares proposed twin state against safety envelopes to ensure
code changes don't introduce unsafe operational configurations.

Options:
  --twins-dir <dir>         Directory containing twin checkpoints (default: .artifacts/twins)
  --base-twin <file>        Base twin checkpoint file (older state)
  --head-twin <file>        Head twin checkpoint file (proposed state)
  --output-file <file>      Output file for results (default: twin-safety-results.json)
  --fail-on-critical        Fail if critical violations found (default: true)
  --fail-on-high            Fail if high severity violations found (default: false)
  --verbose                 Enable verbose output
  -h, --help                Show this help message
`);
  process.exit(0);
}

// =============================================================================
// TYPES
// =============================================================================

type Severity = "none" | "low" | "medium" | "high" | "critical";

interface SafetyViolation {
  id: string;
  category: "safety_constraint" | "alarm_threshold" | "calibration" | "plc_state" | "topology";
  severity: Severity;
  message: string;
  path: string;
  baseValue?: unknown;
  headValue?: unknown;
  constraint?: string;
  recommendation?: string;
}

interface CategorySummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface SafetySummary {
  totalChanges: number;
  totalViolations: number;
  byCategory: Record<string, CategorySummary>;
  bySeverity: Record<Severity, number>;
}

interface SafetyResults {
  timestamp: string;
  safetyLevel: Severity;
  baseTwin: string;
  headTwin: string;
  summary: SafetySummary;
  violations: SafetyViolation[];
  changes: Array<{
    path: string;
    changeType: "added" | "removed" | "modified";
    severity: Severity;
    description: string;
  }>;
  recommendations: string[];
}

// =============================================================================
// TWIN LOADING
// =============================================================================

function loadTwinCheckpoint(filePath: string): TwinCheckpoint | CheckpointState | null {
  if (!existsSync(filePath)) {
    return null;
  }
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    
    // Could be a full checkpoint or just the state
    if (parsed.state) {
      return parsed as TwinCheckpoint;
    } else if (parsed.plcStates || parsed.safetyEnvelopes) {
      return parsed as CheckpointState;
    }
    
    return null;
  } catch (err) {
    console.warn(`⚠️  Failed to parse twin file: ${filePath}`);
    return null;
  }
}

function getState(data: TwinCheckpoint | CheckpointState | null): CheckpointState | null {
  if (!data) return null;
  if ("state" in data && data.state) return data.state;
  if ("plcStates" in data || "safetyEnvelopes" in data) return data as CheckpointState;
  return null;
}

// =============================================================================
// SAFETY CHECKS
// =============================================================================

/**
 * Check for safety constraint changes
 */
function checkSafetyConstraintChanges(
  baseState: CheckpointState | null,
  headState: CheckpointState | null
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  
  const baseConstraints = new Map<string, SafetyConstraint>();
  const headConstraints = new Map<string, SafetyConstraint>();
  
  (baseState?.safetyEnvelopes || []).forEach(c => baseConstraints.set(c.id, c));
  (headState?.safetyEnvelopes || []).forEach(c => headConstraints.set(c.id, c));
  
  // Check for removed constraints
  for (const [id, constraint] of baseConstraints) {
    if (!headConstraints.has(id)) {
      violations.push({
        id: `removed-constraint-${id}`,
        category: "safety_constraint",
        severity: constraint.sil === "sil3" || constraint.sil === "sil4" ? "critical" : 
                  constraint.sil === "sil2" ? "high" : "medium",
        message: `Safety constraint removed: ${constraint.name}`,
        path: `safetyEnvelopes[${id}]`,
        baseValue: constraint,
        headValue: undefined,
        constraint: `SIL ${constraint.sil?.toUpperCase() || "none"} constraint`,
        recommendation: `Review removal of ${constraint.name}. This may require MOC (Management of Change) approval.`,
      });
    }
  }
  
  // Check for modified constraints
  for (const [id, headConstraint] of headConstraints) {
    const baseConstraint = baseConstraints.get(id);
    
    if (baseConstraint) {
      // Check if constraint was disabled
      if (baseConstraint.active && !headConstraint.active) {
        violations.push({
          id: `disabled-constraint-${id}`,
          category: "safety_constraint",
          severity: headConstraint.sil === "sil3" || headConstraint.sil === "sil4" ? "critical" : "high",
          message: `Safety constraint disabled: ${headConstraint.name}`,
          path: `safetyEnvelopes[${id}].active`,
          baseValue: true,
          headValue: false,
          constraint: `SIL ${headConstraint.sil?.toUpperCase() || "none"} constraint`,
          recommendation: `Disabling safety constraints requires documented justification and approval.`,
        });
      }
      
      // Check if SIL level was lowered
      const silLevels = { none: 0, sil1: 1, sil2: 2, sil3: 3, sil4: 4 };
      const baseSil = silLevels[baseConstraint.sil as keyof typeof silLevels] || 0;
      const headSil = silLevels[headConstraint.sil as keyof typeof silLevels] || 0;
      
      if (headSil < baseSil) {
        violations.push({
          id: `lowered-sil-${id}`,
          category: "safety_constraint",
          severity: "critical",
          message: `SIL level lowered for constraint: ${headConstraint.name}`,
          path: `safetyEnvelopes[${id}].sil`,
          baseValue: baseConstraint.sil,
          headValue: headConstraint.sil,
          recommendation: `SIL level reductions require formal safety analysis and regulatory review.`,
        });
      }
      
      // Check for parameter changes on range constraints
      if (headConstraint.type === "range" && baseConstraint.type === "range") {
        const baseParams = baseConstraint.parameters as { type: "range"; min?: number; max?: number };
        const headParams = headConstraint.parameters as { type: "range"; min?: number; max?: number };
        
        // Check if range was widened (less restrictive)
        if (baseParams.min !== undefined && headParams.min !== undefined && headParams.min < baseParams.min) {
          violations.push({
            id: `widened-min-${id}`,
            category: "safety_constraint",
            severity: headConstraint.sil === "sil1" || headConstraint.sil === "none" ? "low" : "medium",
            message: `Minimum limit lowered for ${headConstraint.name}`,
            path: `safetyEnvelopes[${id}].parameters.min`,
            baseValue: baseParams.min,
            headValue: headParams.min,
            recommendation: `Verify new minimum limit is within safe operating envelope.`,
          });
        }
        
        if (baseParams.max !== undefined && headParams.max !== undefined && headParams.max > baseParams.max) {
          violations.push({
            id: `widened-max-${id}`,
            category: "safety_constraint",
            severity: headConstraint.sil === "sil1" || headConstraint.sil === "none" ? "low" : "medium",
            message: `Maximum limit raised for ${headConstraint.name}`,
            path: `safetyEnvelopes[${id}].parameters.max`,
            baseValue: baseParams.max,
            headValue: headParams.max,
            recommendation: `Verify new maximum limit is within safe operating envelope.`,
          });
        }
      }
    }
  }
  
  return violations;
}

/**
 * Check for alarm threshold changes
 */
function checkAlarmThresholdChanges(
  baseState: CheckpointState | null,
  headState: CheckpointState | null
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  
  const baseAlarms = new Map<string, AlarmThreshold>();
  const headAlarms = new Map<string, AlarmThreshold>();
  
  (baseState?.alarmThresholds?.thresholds || []).forEach(a => baseAlarms.set(a.id, a));
  (headState?.alarmThresholds?.thresholds || []).forEach(a => headAlarms.set(a.id, a));
  
  // Check for disabled or removed high-priority alarms
  for (const [id, baseAlarm] of baseAlarms) {
    const headAlarm = headAlarms.get(id);
    
    if (!headAlarm) {
      // Alarm removed
      const severity = baseAlarm.priority === "critical" ? "critical" :
                       baseAlarm.priority === "high" ? "high" : "medium";
      violations.push({
        id: `removed-alarm-${id}`,
        category: "alarm_threshold",
        severity,
        message: `Alarm removed: ${baseAlarm.name} (${baseAlarm.priority} priority)`,
        path: `alarmThresholds.thresholds[${id}]`,
        baseValue: baseAlarm,
        headValue: undefined,
        recommendation: `Review removal of ${baseAlarm.priority} priority alarm. Ensure adequate protection remains.`,
      });
    } else {
      // Check if alarm was disabled
      if (baseAlarm.enabled && !headAlarm.enabled) {
        const severity = baseAlarm.priority === "critical" ? "critical" :
                         baseAlarm.priority === "high" ? "high" : "low";
        violations.push({
          id: `disabled-alarm-${id}`,
          category: "alarm_threshold",
          severity,
          message: `Alarm disabled: ${headAlarm.name}`,
          path: `alarmThresholds.thresholds[${id}].enabled`,
          baseValue: true,
          headValue: false,
          recommendation: `Disabling ${headAlarm.priority} priority alarms should be documented.`,
        });
      }
      
      // Check if priority was lowered
      const priorityLevels = { diagnostic: 0, low: 1, medium: 2, high: 3, critical: 4 };
      const basePriority = priorityLevels[baseAlarm.priority as keyof typeof priorityLevels] || 0;
      const headPriority = priorityLevels[headAlarm.priority as keyof typeof priorityLevels] || 0;
      
      if (headPriority < basePriority) {
        violations.push({
          id: `lowered-priority-${id}`,
          category: "alarm_threshold",
          severity: basePriority >= 3 ? "high" : "medium",
          message: `Alarm priority lowered: ${headAlarm.name} (${baseAlarm.priority} → ${headAlarm.priority})`,
          path: `alarmThresholds.thresholds[${id}].priority`,
          baseValue: baseAlarm.priority,
          headValue: headAlarm.priority,
          recommendation: `Verify alarm rationalization justifies priority change.`,
        });
      }
      
      // Check for threshold widening
      if (baseAlarm.type === headAlarm.type) {
        const isHighType = ["high", "high_high"].includes(baseAlarm.type);
        const isLowType = ["low", "low_low"].includes(baseAlarm.type);
        
        if (isHighType && headAlarm.threshold > baseAlarm.threshold) {
          violations.push({
            id: `widened-high-${id}`,
            category: "alarm_threshold",
            severity: baseAlarm.priority === "critical" ? "high" : "low",
            message: `High alarm threshold raised: ${headAlarm.name}`,
            path: `alarmThresholds.thresholds[${id}].threshold`,
            baseValue: baseAlarm.threshold,
            headValue: headAlarm.threshold,
            recommendation: `Verify process can safely operate at higher value before alarm.`,
          });
        }
        
        if (isLowType && headAlarm.threshold < baseAlarm.threshold) {
          violations.push({
            id: `widened-low-${id}`,
            category: "alarm_threshold",
            severity: baseAlarm.priority === "critical" ? "high" : "low",
            message: `Low alarm threshold lowered: ${headAlarm.name}`,
            path: `alarmThresholds.thresholds[${id}].threshold`,
            baseValue: baseAlarm.threshold,
            headValue: headAlarm.threshold,
            recommendation: `Verify process can safely operate at lower value before alarm.`,
          });
        }
      }
    }
  }
  
  return violations;
}

/**
 * Check for PLC state changes
 */
function checkPLCStateChanges(
  baseState: CheckpointState | null,
  headState: CheckpointState | null
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  
  const basePLCs = new Map<string, PLCState>();
  const headPLCs = new Map<string, PLCState>();
  
  (baseState?.plcStates || []).forEach(p => basePLCs.set(p.controllerId, p));
  (headState?.plcStates || []).forEach(p => headPLCs.set(p.controllerId, p));
  
  // Check for removed controllers
  for (const [id, basePLC] of basePLCs) {
    if (!headPLCs.has(id)) {
      violations.push({
        id: `removed-plc-${id}`,
        category: "plc_state",
        severity: "high",
        message: `Controller removed from configuration: ${basePLC.controllerName}`,
        path: `plcStates[${id}]`,
        baseValue: basePLC.controllerName,
        headValue: undefined,
        recommendation: `Verify controller removal is intentional and all dependent processes are handled.`,
      });
    }
  }
  
  // Check for firmware version changes
  for (const [id, headPLC] of headPLCs) {
    const basePLC = basePLCs.get(id);
    
    if (basePLC && basePLC.firmwareVersion !== headPLC.firmwareVersion) {
      violations.push({
        id: `firmware-change-${id}`,
        category: "plc_state",
        severity: "medium",
        message: `Firmware version changed: ${headPLC.controllerName}`,
        path: `plcStates[${id}].firmwareVersion`,
        baseValue: basePLC.firmwareVersion,
        headValue: headPLC.firmwareVersion,
        recommendation: `Verify firmware change has been tested and approved. Coordinate with vendor if necessary.`,
      });
    }
    
    // Check for mode changes to potentially unsafe modes
    if (basePLC && basePLC.mode !== headPLC.mode) {
      const unsafeModes = ["program", "fault", "offline"];
      const isUnsafe = unsafeModes.includes(headPLC.mode);
      
      if (isUnsafe) {
        violations.push({
          id: `unsafe-mode-${id}`,
          category: "plc_state",
          severity: "critical",
          message: `Controller in unsafe mode: ${headPLC.controllerName} is in ${headPLC.mode} mode`,
          path: `plcStates[${id}].mode`,
          baseValue: basePLC.mode,
          headValue: headPLC.mode,
          recommendation: `Controllers should not be left in ${headPLC.mode} mode during normal operation.`,
        });
      }
    }
  }
  
  return violations;
}

/**
 * Check for calibration issues
 */
function checkCalibrationChanges(
  baseState: CheckpointState | null,
  headState: CheckpointState | null
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  
  const baseCalibs = new Map<string, CalibrationRecord>();
  const headCalibs = new Map<string, CalibrationRecord>();
  
  (baseState?.calibrations?.records || []).forEach(c => baseCalibs.set(c.id, c));
  (headState?.calibrations?.records || []).forEach(c => headCalibs.set(c.id, c));
  
  // Check for removed calibrations
  for (const [id, baseCalib] of baseCalibs) {
    if (!headCalibs.has(id)) {
      violations.push({
        id: `removed-calib-${id}`,
        category: "calibration",
        severity: "medium",
        message: `Calibration record removed: ${baseCalib.tagPath}`,
        path: `calibrations.records[${id}]`,
        baseValue: baseCalib.tagPath,
        headValue: undefined,
        recommendation: `Verify calibration removal is intentional. Instrument may still require calibration.`,
      });
    }
  }
  
  // Check for out-of-tolerance calibrations
  for (const [id, headCalib] of headCalibs) {
    if (!headCalib.asLeft.pass) {
      violations.push({
        id: `out-of-tolerance-${id}`,
        category: "calibration",
        severity: "high",
        message: `Instrument out of tolerance after calibration: ${headCalib.tagPath}`,
        path: `calibrations.records[${id}].asLeft.pass`,
        baseValue: true,
        headValue: false,
        recommendation: `Instrument ${headCalib.tagPath} requires repair or replacement.`,
      });
    }
    
    // Check for overdue calibrations
    if (headCalib.nextDue) {
      const dueDate = new Date(headCalib.nextDue);
      const now = new Date();
      
      if (dueDate < now) {
        violations.push({
          id: `overdue-calib-${id}`,
          category: "calibration",
          severity: "medium",
          message: `Calibration overdue: ${headCalib.tagPath}`,
          path: `calibrations.records[${id}].nextDue`,
          baseValue: headCalib.nextDue,
          headValue: "overdue",
          recommendation: `Schedule calibration for ${headCalib.tagPath} as soon as possible.`,
        });
      }
    }
  }
  
  return violations;
}

// =============================================================================
// MAIN SAFETY CHECK
// =============================================================================

function runSafetyChecks(
  baseData: TwinCheckpoint | CheckpointState | null,
  headData: TwinCheckpoint | CheckpointState | null
): SafetyResults {
  const baseState = getState(baseData);
  const headState = getState(headData);
  
  const allViolations: SafetyViolation[] = [];
  
  // Run all safety checks
  allViolations.push(...checkSafetyConstraintChanges(baseState, headState));
  allViolations.push(...checkAlarmThresholdChanges(baseState, headState));
  allViolations.push(...checkPLCStateChanges(baseState, headState));
  allViolations.push(...checkCalibrationChanges(baseState, headState));
  
  // Calculate summary
  const byCategory: Record<string, CategorySummary> = {
    safety_constraint: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    alarm_threshold: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    plc_state: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    calibration: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    topology: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
  };
  
  const bySeverity: Record<Severity, number> = {
    none: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  
  for (const violation of allViolations) {
    byCategory[violation.category].total++;
    byCategory[violation.category][violation.severity]++;
    bySeverity[violation.severity]++;
  }
  
  // Determine overall safety level
  let safetyLevel: Severity = "none";
  if (bySeverity.low > 0) safetyLevel = "low";
  if (bySeverity.medium > 0) safetyLevel = "medium";
  if (bySeverity.high > 0) safetyLevel = "high";
  if (bySeverity.critical > 0) safetyLevel = "critical";
  
  // Generate recommendations
  const recommendations: string[] = [];
  
  if (bySeverity.critical > 0) {
    recommendations.push("⛔ CRITICAL: This change contains critical safety violations that must be addressed before merge.");
    recommendations.push("Consider implementing a formal Management of Change (MOC) process.");
  }
  
  if (bySeverity.high > 0) {
    recommendations.push("🔴 HIGH: Review all high-severity findings with your safety team.");
  }
  
  if (bySeverity.medium > 0) {
    recommendations.push("🟠 MEDIUM: Document justification for medium-severity changes.");
  }
  
  // Build changes list
  const changes = allViolations.map(v => ({
    path: v.path,
    changeType: v.headValue === undefined ? "removed" as const : 
                v.baseValue === undefined ? "added" as const : "modified" as const,
    severity: v.severity,
    description: v.message,
  }));
  
  return {
    timestamp: new Date().toISOString(),
    safetyLevel,
    baseTwin: args["base-twin"] as string,
    headTwin: args["head-twin"] as string,
    summary: {
      totalChanges: changes.length,
      totalViolations: allViolations.length,
      byCategory,
      bySeverity,
    },
    violations: allViolations,
    changes,
    recommendations,
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  0xSCADA Twin Diff Safety Check");
  console.log("  VERITY Architecture - Artifact-First CI/CD");
  console.log("═══════════════════════════════════════════════════════════════");
  
  const twinsDir = args["twins-dir"] as string;
  const baseTwinPath = args["base-twin"] as string;
  const headTwinPath = args["head-twin"] as string;
  const outputFile = args["output-file"] as string;
  const failOnCritical = args["fail-on-critical"] as boolean;
  const failOnHigh = args["fail-on-high"] as boolean;
  
  // Load twins
  console.log(`\n📊 Loading twin checkpoints...`);
  
  const baseData = baseTwinPath ? loadTwinCheckpoint(baseTwinPath) : null;
  const headData = headTwinPath ? loadTwinCheckpoint(headTwinPath) : null;
  
  console.log(`   - Base twin: ${baseData ? "Loaded" : "Not found"} (${baseTwinPath || "not specified"})`);
  console.log(`   - Head twin: ${headData ? "Loaded" : "Not found"} (${headTwinPath || "not specified"})`);
  
  // Handle no twins case
  if (!baseData && !headData) {
    console.log("\n⚠️  No twin checkpoints found to compare.");
    
    const results: SafetyResults = {
      timestamp: new Date().toISOString(),
      safetyLevel: "none",
      baseTwin: baseTwinPath || "",
      headTwin: headTwinPath || "",
      summary: {
        totalChanges: 0,
        totalViolations: 0,
        byCategory: {
          safety_constraint: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          alarm_threshold: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          plc_state: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          calibration: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          topology: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        },
        bySeverity: { none: 0, low: 0, medium: 0, high: 0, critical: 0 },
      },
      violations: [],
      changes: [],
      recommendations: [],
    };
    
    writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\n📄 Results written to: ${outputFile}`);
    console.log("\n✅ No twins to compare - passing by default.\n");
    process.exit(0);
  }
  
  // Run safety checks
  console.log("\n🛡️ Running safety checks...\n");
  
  const results = runSafetyChecks(baseData, headData);
  
  // Report violations
  const severityEmoji = {
    none: "✅",
    low: "🟡",
    medium: "🟠",
    high: "🔴",
    critical: "⛔",
  };
  
  for (const violation of results.violations) {
    console.log(`  ${severityEmoji[violation.severity]} [${violation.severity.toUpperCase()}] ${violation.message}`);
    if (args.verbose && violation.recommendation) {
      console.log(`     └─ ${violation.recommendation}`);
    }
  }
  
  if (results.violations.length === 0) {
    console.log("  ✅ No safety violations detected.");
  }
  
  // Write results
  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`\n📄 Results written to: ${outputFile}`);
  
  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SAFETY CHECK SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Overall Safety Level: ${severityEmoji[results.safetyLevel]} ${results.safetyLevel.toUpperCase()}`);
  console.log("");
  console.log(`  Violations by Severity:`);
  console.log(`    Critical: ${results.summary.bySeverity.critical}`);
  console.log(`    High:     ${results.summary.bySeverity.high}`);
  console.log(`    Medium:   ${results.summary.bySeverity.medium}`);
  console.log(`    Low:      ${results.summary.bySeverity.low}`);
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  // Print recommendations
  if (results.recommendations.length > 0) {
    console.log("📋 RECOMMENDATIONS:");
    results.recommendations.forEach(r => console.log(`   ${r}`));
    console.log("");
  }
  
  // Determine exit code
  if (failOnCritical && results.summary.bySeverity.critical > 0) {
    console.log("❌ Twin diff safety check failed: Critical violations found.\n");
    process.exit(1);
  }
  
  if (failOnHigh && results.summary.bySeverity.high > 0) {
    console.log("❌ Twin diff safety check failed: High severity violations found.\n");
    process.exit(1);
  }
  
  if (results.safetyLevel === "none" || results.safetyLevel === "low") {
    console.log("✅ Twin diff safety check passed.\n");
  } else {
    console.log(`⚠️ Twin diff safety check completed with ${results.safetyLevel} severity findings.\n`);
  }
  
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
