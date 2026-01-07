/**
 * 0xSCADA Change-Control Agent
 * 
 * PRD Section 6.4: Required Agent (P0)
 * - Consumes blueprint changes
 * - Generates PLC code via codegen
 * - Produces change packages: diffs, test plans, rollback steps
 * - Hashes and anchors intent
 */

import { 
  BaseAgent, 
  AgentCapability, 
  AgentOutputType,
  type AgentConfig,
  generateAgentKeys,
} from "./base";
import type { SignedEvent } from "../events";
import { sha256 } from "../crypto";

// =============================================================================
// CHANGE-CONTROL AGENT CONFIGURATION
// =============================================================================

const CHANGE_CONTROL_CAPABILITIES: AgentCapability[] = [
  AgentCapability.READ_BLUEPRINTS,
  AgentCapability.READ_EVENTS,
  AgentCapability.GENERATE_CODE,
  AgentCapability.GENERATE_TESTS,
  AgentCapability.PROPOSE_CHANGES,
  AgentCapability.PROPOSE_DEPLOYMENTS,
];

// =============================================================================
// CHANGE PACKAGE TYPES
// =============================================================================

export interface ChangePackage {
  id: string;
  blueprintId: string;
  blueprintName: string;
  blueprintHash: string;
  previousHash?: string;
  
  // Generated code
  codegenId?: string;
  codeHash?: string;
  language?: string;
  vendorId?: string;
  
  // Change details
  diff: string;
  testPlan: string[];
  rollbackSteps: string[];
  estimatedDowntime?: string;
  
  // Risk assessment
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskFactors: string[];
  
  // Status
  status: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "DEPLOYED";
  
  createdAt: Date;
  createdBy: string;
}

// =============================================================================
// CHANGE-CONTROL AGENT IMPLEMENTATION
// =============================================================================

export class ChangeControlAgent extends BaseAgent {
  private pendingChanges: Map<string, ChangePackage> = new Map();
  private blueprintHashes: Map<string, string> = new Map(); // Track current blueprint hashes

  constructor(config: Partial<AgentConfig> & { id: string; name: string }) {
    const keys = generateAgentKeys();
    
    super({
      id: config.id,
      name: config.name,
      displayName: config.displayName || "Change-Control Agent",
      agentType: "CHANGE_CONTROL",
      capabilities: CHANGE_CONTROL_CAPABILITIES,
      scope: config.scope || {
        allSites: true,
        siteIds: [],
        allAssets: true,
        assetIds: [],
        assetTypes: [],
        allEventTypes: false,
        eventTypes: ["BLUEPRINT_CHANGE", "CODE_GENERATION", "DEPLOYMENT_INTENT"],
      },
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  protected async onStart(): Promise<void> {
    console.log(`   🔧 Change-Control Agent ready - monitoring blueprint changes`);
  }

  protected async onStop(): Promise<void> {
    // Save pending changes state if needed
  }

  // ==========================================================================
  // EVENT HANDLING
  // ==========================================================================

  async handleEvent(event: SignedEvent): Promise<void> {
    switch (event.eventType) {
      case "BLUEPRINT_CHANGE":
        await this.handleBlueprintChange(event);
        break;
      case "CODE_GENERATION":
        await this.handleCodeGeneration(event);
        break;
      case "DEPLOYMENT_INTENT":
        await this.handleDeploymentIntent(event);
        break;
    }
  }

  /**
   * Handle blueprint change event
   */
  private async handleBlueprintChange(event: SignedEvent): Promise<void> {
    const payload = event.payload as {
      changeType: string;
      entityType: string;
      entityId: string;
      entityName: string;
      previousHash?: string;
      newHash: string;
      diff?: string;
      reason: string;
      requestedBy: string;
    };

    console.log(`   📝 Blueprint change detected: ${payload.entityName} (${payload.changeType})`);

    // Store the new hash
    this.blueprintHashes.set(payload.entityId, payload.newHash);

    // Create a change package proposal
    const changePackage = await this.createChangePackage({
      blueprintId: payload.entityId,
      blueprintName: payload.entityName,
      blueprintHash: payload.newHash,
      previousHash: payload.previousHash,
      changeType: payload.changeType,
      entityType: payload.entityType,
      diff: payload.diff,
      reason: payload.reason,
      requestedBy: payload.requestedBy,
    });

    this.pendingChanges.set(changePackage.id, changePackage);

    // Create a proposal for review
    const proposal = this.createProposal({
      proposalType: "BLUEPRINT_CHANGE",
      title: `Blueprint Change: ${payload.entityName}`,
      description: `${payload.changeType} operation on ${payload.entityType} "${payload.entityName}". Reason: ${payload.reason}`,
      action: changePackage,
      reasoning: this.generateChangeReasoning(changePackage),
      confidence: 0.85,
      supportingEventIds: [event.hash],
      riskLevel: changePackage.riskLevel,
      riskFactors: changePackage.riskFactors,
      requiredApprovals: changePackage.riskLevel === "CRITICAL" ? 2 : 1,
    });

    console.log(`   📋 Change package created: ${changePackage.id}`);
    console.log(`   ⚠️ Risk level: ${changePackage.riskLevel}`);
  }

  /**
   * Handle code generation event
   */
  private async handleCodeGeneration(event: SignedEvent): Promise<void> {
    const payload = event.payload as {
      sourceType: string;
      sourceId: string;
      sourceName: string;
      sourceHash: string;
      vendorId: string;
      vendorName: string;
      language: string;
      codeHash: string;
      codeSize: number;
      generatedBy: string;
    };

    console.log(`   ⚙️ Code generated for ${payload.sourceName}: ${payload.language}`);

    // Find and update the corresponding change package
    for (const [id, pkg] of this.pendingChanges) {
      if (pkg.blueprintId === payload.sourceId) {
        pkg.codegenId = event.hash;
        pkg.codeHash = payload.codeHash;
        pkg.language = payload.language;
        pkg.vendorId = payload.vendorId;
        this.pendingChanges.set(id, pkg);
        console.log(`   🔗 Linked code generation to change package ${id}`);
        break;
      }
    }
  }

  /**
   * Handle deployment intent event
   */
  private async handleDeploymentIntent(event: SignedEvent): Promise<void> {
    const payload = event.payload as {
      blueprintId: string;
      blueprintName: string;
      status: string;
    };

    console.log(`   🚀 Deployment intent: ${payload.blueprintName} - ${payload.status}`);

    // Update change package status
    for (const [id, pkg] of this.pendingChanges) {
      if (pkg.blueprintId === payload.blueprintId) {
        if (payload.status === "DEPLOYED") {
          pkg.status = "DEPLOYED";
          console.log(`   ✅ Change package ${id} marked as deployed`);
        }
        this.pendingChanges.set(id, pkg);
        break;
      }
    }
  }

  // ==========================================================================
  // CHANGE PACKAGE CREATION
  // ==========================================================================

  /**
   * Create a change package for a blueprint change
   */
  private async createChangePackage(input: {
    blueprintId: string;
    blueprintName: string;
    blueprintHash: string;
    previousHash?: string;
    changeType: string;
    entityType: string;
    diff?: string;
    reason: string;
    requestedBy: string;
  }): Promise<ChangePackage> {
    const id = sha256(`${input.blueprintId}-${Date.now()}`).slice(0, 16);

    // Generate test plan based on entity type
    const testPlan = this.generateTestPlan(input.entityType, input.changeType);

    // Generate rollback steps
    const rollbackSteps = this.generateRollbackSteps(input.entityType, input.changeType, input.previousHash);

    // Assess risk
    const { riskLevel, riskFactors } = this.assessRisk(input);

    return {
      id,
      blueprintId: input.blueprintId,
      blueprintName: input.blueprintName,
      blueprintHash: input.blueprintHash,
      previousHash: input.previousHash,
      diff: input.diff || "No diff available",
      testPlan,
      rollbackSteps,
      riskLevel,
      riskFactors,
      status: "DRAFT",
      createdAt: new Date(),
      createdBy: this.config.id,
    };
  }

  /**
   * Generate test plan for a change
   */
  private generateTestPlan(entityType: string, changeType: string): string[] {
    const basePlan = [
      "1. Verify syntax and compilation of generated code",
      "2. Run static analysis checks",
      "3. Verify I/O mapping correctness",
    ];

    if (entityType === "CONTROL_MODULE") {
      basePlan.push(
        "4. Test control module in simulation environment",
        "5. Verify input/output behavior matches specification",
        "6. Test fault handling and error states",
        "7. Verify communication with upstream/downstream modules"
      );
    } else if (entityType === "PHASE") {
      basePlan.push(
        "4. Test phase state machine transitions",
        "5. Verify sequence logic execution",
        "6. Test abort and hold conditions",
        "7. Verify linked module interactions",
        "8. Test recipe parameter handling"
      );
    } else if (entityType === "UNIT") {
      basePlan.push(
        "4. Test unit coordination logic",
        "5. Verify equipment module interactions",
        "6. Test batch recipe execution",
        "7. Verify safety interlock behavior"
      );
    }

    if (changeType === "UPDATE") {
      basePlan.push(
        `${basePlan.length + 1}. Compare behavior with previous version`,
        `${basePlan.length + 2}. Verify backward compatibility`
      );
    }

    return basePlan;
  }

  /**
   * Generate rollback steps
   */
  private generateRollbackSteps(entityType: string, changeType: string, previousHash?: string): string[] {
    const steps: string[] = [];

    if (changeType === "CREATE") {
      steps.push(
        "1. Remove newly created entity from controller",
        "2. Delete associated data blocks and instances",
        "3. Verify system returns to previous state"
      );
    } else if (changeType === "UPDATE" && previousHash) {
      steps.push(
        "1. Stop affected processes safely",
        `2. Restore previous version (hash: ${previousHash.slice(0, 8)}...)`,
        "3. Recompile and download to controller",
        "4. Verify previous behavior is restored",
        "5. Resume processes"
      );
    } else if (changeType === "DELETE") {
      steps.push(
        "1. Restore entity from backup",
        "2. Recreate associated instances",
        "3. Verify all references are restored",
        "4. Test restored functionality"
      );
    }

    steps.push(
      `${steps.length + 1}. Document rollback in change log`,
      `${steps.length + 2}. Notify stakeholders of rollback`
    );

    return steps;
  }

  /**
   * Assess risk level of a change
   */
  private assessRisk(input: {
    changeType: string;
    entityType: string;
    blueprintName: string;
  }): { riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; riskFactors: string[] } {
    const riskFactors: string[] = [];
    let riskScore = 0;

    // Change type risk
    if (input.changeType === "DELETE") {
      riskFactors.push("Deletion operation - irreversible without backup");
      riskScore += 3;
    } else if (input.changeType === "UPDATE") {
      riskFactors.push("Modification of existing logic");
      riskScore += 2;
    } else {
      riskFactors.push("New entity creation");
      riskScore += 1;
    }

    // Entity type risk
    if (input.entityType === "PHASE") {
      riskFactors.push("Phase logic affects batch execution");
      riskScore += 2;
    } else if (input.entityType === "UNIT") {
      riskFactors.push("Unit changes affect multiple equipment modules");
      riskScore += 3;
    }

    // Name-based risk (simplified heuristic)
    const lowerName = input.blueprintName.toLowerCase();
    if (lowerName.includes("safety") || lowerName.includes("interlock")) {
      riskFactors.push("Safety-related component");
      riskScore += 4;
    }
    if (lowerName.includes("critical") || lowerName.includes("emergency")) {
      riskFactors.push("Critical system component");
      riskScore += 3;
    }

    // Determine risk level
    let riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    if (riskScore >= 8) {
      riskLevel = "CRITICAL";
    } else if (riskScore >= 5) {
      riskLevel = "HIGH";
    } else if (riskScore >= 3) {
      riskLevel = "MEDIUM";
    } else {
      riskLevel = "LOW";
    }

    return { riskLevel, riskFactors };
  }

  /**
   * Generate reasoning for a change proposal
   */
  private generateChangeReasoning(pkg: ChangePackage): string {
    return `Change package created for blueprint "${pkg.blueprintName}". ` +
      `Risk assessment: ${pkg.riskLevel} based on ${pkg.riskFactors.length} factors. ` +
      `Test plan includes ${pkg.testPlan.length} steps. ` +
      `Rollback procedure defined with ${pkg.rollbackSteps.length} steps.`;
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  getPendingChanges(): ChangePackage[] {
    return Array.from(this.pendingChanges.values());
  }

  getChangePackage(id: string): ChangePackage | undefined {
    return this.pendingChanges.get(id);
  }

  getBlueprintHash(blueprintId: string): string | undefined {
    return this.blueprintHashes.get(blueprintId);
  }
}
