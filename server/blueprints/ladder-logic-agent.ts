/**
 * Ladder Logic AI Agent
 * Provides AI-driven code generation for ladder logic
 * 
 * This module enables an AI coding agent within 0xSCADA to generate
 * ladder logic code similar to the LadderLogix application.
 */

import type { ParsedCMType, ParsedPhaseType, PhaseSequenceStep } from "./types";
import type {
  LadderRung,
  LadderRoutine,
  LadderProgram,
  LadderTag,
  InstructionDefinition,
  InstructionCategory,
} from "./ladder-logic-types";
import { INSTRUCTION_LIBRARY, getInstruction, getInstructionsByCategory } from "./ladder-logic-types";
import { RungBuilder, rung, rungToNeutralText, routineToNeutralText } from "./neutral-text-generator";

/**
 * Agent context for code generation
 * This provides the AI agent with all necessary information to generate code
 */
export interface AgentContext {
  // Source blueprint information
  sourceType: "control_module" | "phase" | "unit";
  sourceName: string;
  description?: string;
  
  // Available tags and their types
  inputs: AgentTag[];
  outputs: AgentTag[];
  inOuts: AgentTag[];
  internalTags: AgentTag[];
  
  // Linked modules (for phases)
  linkedModules: AgentLinkedModule[];
  
  // Sequence information (for phases)
  sequences: AgentSequence[];
  
  // Generation preferences
  preferences: AgentPreferences;
}

export interface AgentTag {
  name: string;
  dataType: string;
  description?: string;
  isPrimary?: boolean;
  isError?: boolean;
  suffix?: string;
}

export interface AgentLinkedModule {
  name: string;
  type: string;
  isDynamic?: boolean;
}

export interface AgentSequence {
  name: string;
  steps: AgentSequenceStep[];
}

export interface AgentSequenceStep {
  stepNumber: number;
  actions: string[];
  transitions: AgentTransition[];
}

export interface AgentTransition {
  condition: string;
  targetStep: number;
}

export interface AgentPreferences {
  includeComments: boolean;
  generateFaultHandling: boolean;
  generateInterlocks: boolean;
  namingConvention: "camelCase" | "PascalCase" | "snake_case" | "UPPER_CASE";
  tagPrefix?: string;
}

/**
 * Agent generation result
 */
export interface AgentGenerationResult {
  success: boolean;
  routines: GeneratedRoutine[];
  tags: LadderTag[];
  neutralText: string;
  errors: string[];
  warnings: string[];
  metadata: {
    generatedAt: string;
    rungCount: number;
    instructionCount: number;
  };
}

export interface GeneratedRoutine {
  name: string;
  type: "Ladder" | "ST";
  rungs: LadderRung[];
  neutralText: string;
}

/**
 * Ladder Logic Agent
 * Generates ladder logic code from blueprints definitions
 */
export class LadderLogicAgent {
  private context: AgentContext | null = null;

  /**
   * Build agent context from a Control Module Type
   */
  buildContextFromCMType(cmType: ParsedCMType, preferences?: Partial<AgentPreferences>): AgentContext {
    const defaultPrefs: AgentPreferences = {
      includeComments: true,
      generateFaultHandling: true,
      generateInterlocks: true,
      namingConvention: "PascalCase",
      ...preferences,
    };

    return {
      sourceType: "control_module",
      sourceName: cmType.name,
      inputs: cmType.inputs.map(i => ({
        name: i.name,
        dataType: i.dataType,
        description: i.comment,
        isPrimary: i.primary,
        isError: i.isError,
        suffix: i.suffix,
      })),
      outputs: cmType.outputs.map(o => ({
        name: o.name,
        dataType: o.dataType,
        description: o.comment,
        isPrimary: o.primary,
        isError: o.isError,
        suffix: o.suffix,
      })),
      inOuts: cmType.inOuts.map(io => ({
        name: io.name,
        dataType: io.dataType,
        description: io.comment,
      })),
      internalTags: [],
      linkedModules: [],
      sequences: [],
      preferences: defaultPrefs,
    };
  }

  /**
   * Build agent context from a Phase Type
   */
  buildContextFromPhaseType(phaseType: ParsedPhaseType, preferences?: Partial<AgentPreferences>): AgentContext {
    const defaultPrefs: AgentPreferences = {
      includeComments: true,
      generateFaultHandling: true,
      generateInterlocks: true,
      namingConvention: "PascalCase",
      ...preferences,
    };

    const sequences: AgentSequence[] = [];
    if (phaseType.sequences) {
      for (const [name, seq] of Object.entries(phaseType.sequences)) {
        if (seq && seq.steps) {
          sequences.push({
            name,
            steps: seq.steps.map((step: PhaseSequenceStep) => ({
              stepNumber: step.step,
              actions: step.actions || [],
              transitions: (step.conditions || []).map(c => ({
                condition: c.condition,
                targetStep: c.target,
              })),
            })),
          });
        }
      }
    }

    return {
      sourceType: "phase",
      sourceName: phaseType.name,
      description: phaseType.description,
      inputs: (phaseType.inputs || []).map(i => ({
        name: i.name,
        dataType: i.dataType,
        description: i.comment,
      })),
      outputs: (phaseType.outputs || []).map(o => ({
        name: o.name,
        dataType: o.dataType,
        description: o.comment,
      })),
      inOuts: (phaseType.inOuts || []).map(io => ({
        name: io.name,
        dataType: io.dataType,
        description: io.comment,
      })),
      internalTags: (phaseType.internalValues || []).map(iv => ({
        name: iv.name,
        dataType: iv.dataType,
        description: iv.comment,
      })),
      linkedModules: (phaseType.linkedModules || []).map(lm => ({
        name: lm.name,
        type: lm.type,
        isDynamic: lm.dynamic,
      })),
      sequences,
      preferences: defaultPrefs,
    };
  }

  /**
   * Generate ladder logic for a Control Module
   */
  generateControlModuleLogic(context: AgentContext): AgentGenerationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const rungs: LadderRung[] = [];
    const tags: LadderTag[] = [];
    let rungNumber = 0;

    try {
      // Generate enable/disable logic
      const enableRung = this.generateEnableRung(context, rungNumber++);
      rungs.push(enableRung);

      // Generate fault detection logic
      if (context.preferences.generateFaultHandling) {
        const faultRungs = this.generateFaultRungs(context, rungNumber);
        rungs.push(...faultRungs);
        rungNumber += faultRungs.length;
      }

      // Generate interlock logic
      if (context.preferences.generateInterlocks) {
        const interlockRungs = this.generateInterlockRungs(context, rungNumber);
        rungs.push(...interlockRungs);
        rungNumber += interlockRungs.length;
      }

      // Generate primary output logic
      const outputRungs = this.generateOutputRungs(context, rungNumber);
      rungs.push(...outputRungs);
      rungNumber += outputRungs.length;

      // Generate required tags
      tags.push(...this.generateRequiredTags(context));

      // Build routine
      const routine: LadderRoutine = {
        name: `${context.sourceName}_Logic`,
        type: "Ladder",
        rungs,
      };

      const neutralText = routineToNeutralText(routine, {
        includeComments: context.preferences.includeComments,
      });

      return {
        success: true,
        routines: [{
          name: routine.name,
          type: "Ladder",
          rungs,
          neutralText,
        }],
        tags,
        neutralText,
        errors: [],
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          rungCount: rungs.length,
          instructionCount: this.countInstructions(rungs),
        },
      };
    } catch (error) {
      errors.push(`Generation failed: ${error}`);
      return {
        success: false,
        routines: [],
        tags: [],
        neutralText: "",
        errors,
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          rungCount: 0,
          instructionCount: 0,
        },
      };
    }
  }

  /**
   * Generate ladder logic for a Phase
   */
  generatePhaseLogic(context: AgentContext): AgentGenerationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const routines: GeneratedRoutine[] = [];
    const tags: LadderTag[] = [];

    try {
      // Generate main logic routine
      const mainRungs = this.generatePhaseMainLogic(context);
      const mainRoutine: LadderRoutine = {
        name: `${context.sourceName}_Main`,
        type: "Ladder",
        rungs: mainRungs,
      };
      routines.push({
        name: mainRoutine.name,
        type: "Ladder",
        rungs: mainRungs,
        neutralText: routineToNeutralText(mainRoutine),
      });

      // Generate state-specific routines
      for (const sequence of context.sequences) {
        const stateRungs = this.generateSequenceRungs(context, sequence);
        const stateRoutine: LadderRoutine = {
          name: `${context.sourceName}_${sequence.name}`,
          type: "Ladder",
          rungs: stateRungs,
        };
        routines.push({
          name: stateRoutine.name,
          type: "Ladder",
          rungs: stateRungs,
          neutralText: routineToNeutralText(stateRoutine),
        });
      }

      // Generate required tags
      tags.push(...this.generatePhaseTags(context));

      // Combine all neutral text
      const allNeutralText = routines.map(r => r.neutralText).join("\n\n");
      const totalRungs = routines.reduce((sum, r) => sum + r.rungs.length, 0);

      return {
        success: true,
        routines,
        tags,
        neutralText: allNeutralText,
        errors: [],
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          rungCount: totalRungs,
          instructionCount: routines.reduce((sum, r) => sum + this.countInstructions(r.rungs), 0),
        },
      };
    } catch (error) {
      errors.push(`Phase generation failed: ${error}`);
      return {
        success: false,
        routines: [],
        tags: [],
        neutralText: "",
        errors,
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          rungCount: 0,
          instructionCount: 0,
        },
      };
    }
  }

  /**
   * Generate enable/disable rung
   */
  private generateEnableRung(context: AgentContext, rungNumber: number): LadderRung {
    const builder = rung(rungNumber)
      .withComment(`${context.sourceName} Enable Logic`);

    // Look for enable input
    const enableInput = context.inputs.find(i => 
      i.name.toLowerCase().includes("enable") || i.name.toLowerCase().includes("cmd")
    );

    if (enableInput) {
      builder.xic(enableInput.name);
    } else {
      builder.xic("Enable");
    }

    builder.ote("Enabled");

    return builder.build();
  }

  /**
   * Generate fault detection rungs
   */
  private generateFaultRungs(context: AgentContext, startRungNumber: number): LadderRung[] {
    const rungs: LadderRung[] = [];
    let rungNumber = startRungNumber;

    // Find error inputs
    const errorInputs = context.inputs.filter(i => i.isError);

    if (errorInputs.length > 0) {
      // Generate individual fault rungs
      for (const errorInput of errorInputs) {
        const faultRung = rung(rungNumber++)
          .withComment(`Fault: ${errorInput.description || errorInput.name}`)
          .xic(errorInput.name)
          .otl("Fault")
          .build();
        rungs.push(faultRung);
      }

      // Generate fault reset rung
      const resetRung = rung(rungNumber++)
        .withComment("Fault Reset")
        .xic("FaultReset")
        .otu("Fault")
        .build();
      rungs.push(resetRung);
    } else {
      // Generate placeholder fault rung
      const placeholderRung = rung(rungNumber++)
        .withComment("Fault Detection - Add fault conditions here")
        .instruction("AFI")
        .ote("Fault")
        .build();
      rungs.push(placeholderRung);
    }

    return rungs;
  }

  /**
   * Generate interlock rungs
   */
  private generateInterlockRungs(context: AgentContext, startRungNumber: number): LadderRung[] {
    const rungs: LadderRung[] = [];
    let rungNumber = startRungNumber;

    // Generate interlock OK rung
    const interlockRung = rung(rungNumber++)
      .withComment("Interlock Status")
      .xic("Enabled")
      .xio("Fault")
      .ote("InterlockOK")
      .build();
    rungs.push(interlockRung);

    return rungs;
  }

  /**
   * Generate output rungs
   */
  private generateOutputRungs(context: AgentContext, startRungNumber: number): LadderRung[] {
    const rungs: LadderRung[] = [];
    let rungNumber = startRungNumber;

    // Generate rungs for primary outputs
    const primaryOutputs = context.outputs.filter(o => o.isPrimary);
    
    for (const output of primaryOutputs) {
      const outputRung = rung(rungNumber++)
        .withComment(`Output: ${output.description || output.name}`)
        .xic("InterlockOK")
        .ote(output.name)
        .build();
      rungs.push(outputRung);
    }

    // If no primary outputs, generate placeholder
    if (primaryOutputs.length === 0 && context.outputs.length > 0) {
      const firstOutput = context.outputs[0];
      const outputRung = rung(rungNumber++)
        .withComment(`Output: ${firstOutput.description || firstOutput.name}`)
        .xic("InterlockOK")
        .ote(firstOutput.name)
        .build();
      rungs.push(outputRung);
    }

    return rungs;
  }

  /**
   * Generate required tags for control module
   */
  private generateRequiredTags(context: AgentContext): LadderTag[] {
    const tags: LadderTag[] = [];

    // Add internal control tags
    tags.push(
      { name: "Enabled", dataType: "BOOL", scope: "program", description: "Module enabled status" },
      { name: "Fault", dataType: "BOOL", scope: "program", description: "Module fault status" },
      { name: "FaultReset", dataType: "BOOL", scope: "program", description: "Fault reset command" },
      { name: "InterlockOK", dataType: "BOOL", scope: "program", description: "Interlock status" }
    );

    return tags;
  }

  /**
   * Generate main logic for phase
   */
  private generatePhaseMainLogic(context: AgentContext): LadderRung[] {
    const rungs: LadderRung[] = [];
    let rungNumber = 0;

    // State machine dispatcher
    const dispatcherRung = rung(rungNumber++)
      .withComment("State Machine Dispatcher - Call state-specific routines")
      .xic("PhaseActive")
      .jsr(`${context.sourceName}_StateHandler`)
      .build();
    rungs.push(dispatcherRung);

    // Generate state transition rungs for each sequence
    for (const sequence of context.sequences) {
      const stateRung = rung(rungNumber++)
        .withComment(`${sequence.name} State Entry`)
        .equ("CurrentState", this.getStateNumber(sequence.name).toString())
        .jsr(`${context.sourceName}_${sequence.name}`)
        .build();
      rungs.push(stateRung);
    }

    return rungs;
  }

  /**
   * Generate rungs for a sequence
   */
  private generateSequenceRungs(context: AgentContext, sequence: AgentSequence): LadderRung[] {
    const rungs: LadderRung[] = [];
    let rungNumber = 0;

    for (const step of sequence.steps) {
      // Step entry rung
      const stepRung = rung(rungNumber++)
        .withComment(`Step ${step.stepNumber}: ${step.actions.join(", ") || "No actions"}`);

      stepRung.equ("CurrentStep", step.stepNumber.toString());

      // Add actions as comments (actual implementation would parse actions)
      for (const action of step.actions) {
        // Parse action and generate appropriate instruction
        // This is a simplified version - real implementation would parse action syntax
      }

      stepRung.ote(`Step${step.stepNumber}Active`);
      rungs.push(stepRung.build());

      // Generate transition rungs
      for (const transition of step.transitions) {
        const transitionRung = rung(rungNumber++)
          .withComment(`Transition: ${transition.condition} -> Step ${transition.targetStep}`)
          .xic(`Step${step.stepNumber}Active`)
          .xic(this.parseConditionToTag(transition.condition))
          .mov(transition.targetStep.toString(), "CurrentStep")
          .build();
        rungs.push(transitionRung);
      }
    }

    return rungs;
  }

  /**
   * Generate tags for phase
   */
  private generatePhaseTags(context: AgentContext): LadderTag[] {
    const tags: LadderTag[] = [];

    // State machine tags
    tags.push(
      { name: "CurrentState", dataType: "DINT", scope: "program", description: "Current state machine state" },
      { name: "CurrentStep", dataType: "DINT", scope: "program", description: "Current step within state" },
      { name: "PhaseActive", dataType: "BOOL", scope: "program", description: "Phase is active" }
    );

    // Step active tags
    for (const sequence of context.sequences) {
      for (const step of sequence.steps) {
        tags.push({
          name: `Step${step.stepNumber}Active`,
          dataType: "BOOL",
          scope: "program",
          description: `Step ${step.stepNumber} active in ${sequence.name}`,
        });
      }
    }

    return tags;
  }

  /**
   * Get state number from state name
   */
  private getStateNumber(stateName: string): number {
    const stateMap: Record<string, number> = {
      idle: 0,
      starting: 1,
      running: 2,
      pausing: 3,
      paused: 4,
      holding: 5,
      held: 6,
      restarting: 7,
      stopping: 8,
      stopped: 9,
      aborting: 10,
      aborted: 11,
      completing: 12,
      complete: 13,
    };
    return stateMap[stateName.toLowerCase()] ?? 0;
  }

  /**
   * Parse condition string to tag name
   */
  private parseConditionToTag(condition: string): string {
    // Simplified - real implementation would parse condition expressions
    return condition.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  /**
   * Count total instructions in rungs
   */
  private countInstructions(rungs: LadderRung[]): number {
    let count = 0;
    for (const rung of rungs) {
      count += this.countElementInstructions(rung.elements);
    }
    return count;
  }

  /**
   * Count instructions in elements
   */
  private countElementInstructions(elements: any[]): number {
    let count = 0;
    for (const elem of elements) {
      if (elem.type === "branch") {
        for (const path of elem.paths) {
          count += this.countElementInstructions(path);
        }
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Get instruction library for AI context
   */
  getInstructionLibrary(): Record<string, InstructionDefinition> {
    return INSTRUCTION_LIBRARY;
  }

  /**
   * Get instructions by category for AI context
   */
  getInstructionsByCategory(category: InstructionCategory): InstructionDefinition[] {
    return getInstructionsByCategory(category);
  }

  /**
   * Generate AI prompt context for external AI integration
   */
  generateAIPromptContext(context: AgentContext): string {
    const lines: string[] = [];

    lines.push("# Ladder Logic Generation Context");
    lines.push("");
    lines.push(`## Source: ${context.sourceType} - ${context.sourceName}`);
    if (context.description) {
      lines.push(`Description: ${context.description}`);
    }
    lines.push("");

    lines.push("## Available Inputs:");
    for (const input of context.inputs) {
      const flags = [];
      if (input.isPrimary) flags.push("PRIMARY");
      if (input.isError) flags.push("ERROR");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      lines.push(`- ${input.name}: ${input.dataType}${flagStr}${input.description ? ` - ${input.description}` : ""}`);
    }
    lines.push("");

    lines.push("## Available Outputs:");
    for (const output of context.outputs) {
      const flags = [];
      if (output.isPrimary) flags.push("PRIMARY");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      lines.push(`- ${output.name}: ${output.dataType}${flagStr}${output.description ? ` - ${output.description}` : ""}`);
    }
    lines.push("");

    if (context.linkedModules.length > 0) {
      lines.push("## Linked Modules:");
      for (const lm of context.linkedModules) {
        lines.push(`- ${lm.name}: ${lm.type}${lm.isDynamic ? " (dynamic)" : ""}`);
      }
      lines.push("");
    }

    if (context.sequences.length > 0) {
      lines.push("## Sequences:");
      for (const seq of context.sequences) {
        lines.push(`### ${seq.name}`);
        for (const step of seq.steps) {
          lines.push(`  Step ${step.stepNumber}:`);
          for (const action of step.actions) {
            lines.push(`    - ${action}`);
          }
          for (const trans of step.transitions) {
            lines.push(`    -> ${trans.condition} => Step ${trans.targetStep}`);
          }
        }
      }
      lines.push("");
    }

    lines.push("## Available Instructions:");
    const categories = ["bit", "timer", "counter", "compare", "math", "move", "program"] as InstructionCategory[];
    for (const category of categories) {
      const instructions = getInstructionsByCategory(category);
      lines.push(`### ${category.toUpperCase()}`);
      for (const inst of instructions.slice(0, 5)) {
        lines.push(`- ${inst.mnemonic}: ${inst.description}`);
      }
    }

    return lines.join("\n");
  }
}

// Singleton instance
export const ladderLogicAgent = new LadderLogicAgent();
