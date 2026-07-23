import { createHash } from "crypto";
import type {
  ControlModuleTypeRow as ControlModuleType,
  PhaseTypeRow as PhaseType,
  UnitTypeRow as UnitType,
  TemplatePackageRow as TemplatePackage,
  VendorRow as Vendor,
  DataTypeMappingRow as DataTypeMapping,
} from "./types";

export interface CodeGenerationInput {
  sourceType: "control_module" | "phase" | "unit";
  sourceId: string;
  vendorId: string;
  templatePackageId?: string;
  // Instance-specific overrides
  instanceName?: string;
  configuration?: Record<string, any>;
}

export interface CodeGenerationResult {
  success: boolean;
  code: string;
  codeHash: string;
  language: string;
  errors: string[];
  warnings: string[];
  metadata: {
    generatedAt: string;
    sourceType: string;
    sourceName: string;
    vendorName: string;
    templateName?: string;
  };
}

export interface TemplateContext {
  CM_NAME?: string;
  PHASE_NAME?: string;
  UNIT_NAME?: string;
  VERSION: string;
  GENERATED_DATE: string;
  INPUTS: Array<{
    name: string;
    dataType: string;
    comment?: string;
    suffix?: string;
  }>;
  OUTPUTS: Array<{
    name: string;
    dataType: string;
    comment?: string;
    suffix?: string;
  }>;
  INOUTS: Array<{
    name: string;
    dataType: string;
    comment?: string;
  }>;
  INTERNAL_VALUES?: Array<{
    name: string;
    dataType: string;
    comment?: string;
  }>;
  LINKED_MODULES?: Array<{
    name: string;
    type: string;
  }>;
  MAIN_LOGIC: string;
  SEQUENCES?: Record<string, any>;
}

/**
 * Code Generation Engine
 * Generates vendor-specific PLC code from blueprints definitions
 */
export class CodeGenerator {
  private dataTypeMappings: Map<string, Map<string, string>> = new Map();

  /**
   * Load data type mappings for a vendor
   */
  loadDataTypeMappings(vendorId: string, mappings: DataTypeMapping[]): void {
    const vendorMap = new Map<string, string>();
    for (const mapping of mappings) {
      vendorMap.set(mapping.canonicalType, mapping.vendorType);
    }
    this.dataTypeMappings.set(vendorId, vendorMap);
  }

  /**
   * Translate a canonical data type to vendor-specific type
   */
  translateDataType(vendorId: string, canonicalType: string): string {
    const vendorMap = this.dataTypeMappings.get(vendorId);
    if (vendorMap && vendorMap.has(canonicalType)) {
      return vendorMap.get(canonicalType)!;
    }
    return canonicalType; // Return as-is if no mapping found
  }

  /**
   * Generate code for a Control Module Type
   */
  generateControlModuleCode(
    cmType: ControlModuleType,
    vendor: Vendor,
    template: TemplatePackage,
    instanceName?: string
  ): CodeGenerationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const context = this.buildCMContext(cmType, vendor.id, instanceName);
      const code = this.processTemplate(template.templateContent, context);
      const codeHash = this.hashCode(code);

      return {
        success: true,
        code,
        codeHash,
        language: template.language,
        errors: [],
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          sourceType: "control_module",
          sourceName: cmType.name,
          vendorName: vendor.displayName,
          templateName: template.name,
        },
      };
    } catch (error) {
      errors.push(`Code generation failed: ${error}`);
      return {
        success: false,
        code: "",
        codeHash: "",
        language: template.language,
        errors,
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          sourceType: "control_module",
          sourceName: cmType.name,
          vendorName: vendor.displayName,
          templateName: template.name,
        },
      };
    }
  }

  /**
   * Generate code for a Phase Type
   */
  generatePhaseCode(
    phaseType: PhaseType,
    vendor: Vendor,
    template: TemplatePackage,
    instanceName?: string
  ): CodeGenerationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const context = this.buildPhaseContext(phaseType, vendor.id, instanceName);
      const code = this.processTemplate(template.templateContent, context);
      const codeHash = this.hashCode(code);

      return {
        success: true,
        code,
        codeHash,
        language: template.language,
        errors: [],
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          sourceType: "phase",
          sourceName: phaseType.name,
          vendorName: vendor.displayName,
          templateName: template.name,
        },
      };
    } catch (error) {
      errors.push(`Code generation failed: ${error}`);
      return {
        success: false,
        code: "",
        codeHash: "",
        language: template.language,
        errors,
        warnings,
        metadata: {
          generatedAt: new Date().toISOString(),
          sourceType: "phase",
          sourceName: phaseType.name,
          vendorName: vendor.displayName,
          templateName: template.name,
        },
      };
    }
  }

  /**
   * Build template context for Control Module
   */
  private buildCMContext(
    cmType: ControlModuleType,
    vendorId: string,
    instanceName?: string
  ): TemplateContext {
    const inputs = (cmType.inputs as any[]) || [];
    const outputs = (cmType.outputs as any[]) || [];
    const inOuts = (cmType.inOuts as any[]) || [];

    return {
      CM_NAME: instanceName || cmType.name,
      VERSION: cmType.version || "1.0.0",
      GENERATED_DATE: new Date().toISOString(),
      INPUTS: inputs.map(i => ({
        name: i.name,
        dataType: this.translateDataType(vendorId, i.dataType),
        comment: i.comment,
        suffix: i.suffix,
      })),
      OUTPUTS: outputs.map(o => ({
        name: o.name,
        dataType: this.translateDataType(vendorId, o.dataType),
        comment: o.comment,
        suffix: o.suffix,
      })),
      INOUTS: inOuts.map(io => ({
        name: io.name,
        dataType: this.translateDataType(vendorId, io.dataType),
        comment: io.comment,
      })),
      MAIN_LOGIC: "// TODO: Implement control logic",
    };
  }

  /**
   * Build template context for Phase
   */
  private buildPhaseContext(
    phaseType: PhaseType,
    vendorId: string,
    instanceName?: string
  ): TemplateContext {
    const inputs = (phaseType.inputs as any[]) || [];
    const outputs = (phaseType.outputs as any[]) || [];
    const inOuts = (phaseType.inOuts as any[]) || [];
    const internalValues = (phaseType.internalValues as any[]) || [];
    const linkedModules = (phaseType.linkedModules as any[]) || [];

    return {
      PHASE_NAME: instanceName || phaseType.name,
      VERSION: phaseType.version || "1.0.0",
      GENERATED_DATE: new Date().toISOString(),
      INPUTS: inputs.map(i => ({
        name: i.name,
        dataType: this.translateDataType(vendorId, i.dataType),
        comment: i.comment,
      })),
      OUTPUTS: outputs.map(o => ({
        name: o.name,
        dataType: this.translateDataType(vendorId, o.dataType),
        comment: o.comment,
      })),
      INOUTS: inOuts.map(io => ({
        name: io.name,
        dataType: this.translateDataType(vendorId, io.dataType),
        comment: io.comment,
      })),
      INTERNAL_VALUES: internalValues.map(iv => ({
        name: iv.name,
        dataType: this.translateDataType(vendorId, iv.dataType),
        comment: iv.comment,
      })),
      LINKED_MODULES: linkedModules.map(lm => ({
        name: lm.name,
        type: lm.type,
      })),
      SEQUENCES: phaseType.sequences as Record<string, any>,
      MAIN_LOGIC: this.generateSequenceLogic(phaseType.sequences as Record<string, any>),
    };
  }

  /**
   * Generate sequence logic from phase sequences
   */
  private generateSequenceLogic(sequences: Record<string, any>): string {
    if (!sequences || Object.keys(sequences).length === 0) {
      return "// No sequences defined";
    }

    const lines: string[] = ["// State machine logic"];
    lines.push("CASE #CurrentState OF");

    for (const [stateName, sequence] of Object.entries(sequences)) {
      if (!sequence || !sequence.steps) continue;
      
      lines.push(`  ${stateName.toUpperCase()}:`);
      lines.push(`    // ${stateName} state logic`);
      
      for (const step of sequence.steps) {
        lines.push(`    // Step ${step.step}`);
        for (const action of step.actions || []) {
          lines.push(`    // ${action}`);
        }
      }
      lines.push("");
    }

    lines.push("END_CASE;");
    return lines.join("\n");
  }

  /**
   * Process a template with the given context
   * Supports {{variable}}, {{#each array}}...{{/each}}, and {{#if condition}}...{{/if}}
   */
  processTemplate(template: string, context: TemplateContext): string {
    let result = template;

    // Replace simple variables {{VAR_NAME}}
    result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = (context as any)[key];
      if (value === undefined) return match;
      if (typeof value === "string") return value;
      return String(value);
    });

    // Process {{#each ARRAY}}...{{/each}} blocks
    result = this.processEachBlocks(result, context);

    // Process {{#if CONDITION}}...{{/if}} blocks
    result = this.processIfBlocks(result, context);

    return result;
  }

  /**
   * Process {{#each}} blocks
   */
  private processEachBlocks(template: string, context: TemplateContext): string {
    const eachRegex = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
    
    return template.replace(eachRegex, (match, arrayName, blockContent) => {
      const array = (context as any)[arrayName];
      if (!Array.isArray(array)) return "";

      return array.map(item => {
        let itemResult = blockContent;
        // Replace item properties
        for (const [key, value] of Object.entries(item)) {
          const itemRegex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
          itemResult = itemResult.replace(itemRegex, String(value || ""));
        }
        return itemResult;
      }).join("");
    });
  }

  /**
   * Process {{#if}} blocks
   */
  private processIfBlocks(template: string, context: TemplateContext): string {
    const ifRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
    
    return template.replace(ifRegex, (match, conditionName, blockContent) => {
      const condition = (context as any)[conditionName];
      if (condition && (Array.isArray(condition) ? condition.length > 0 : Boolean(condition))) {
        return blockContent;
      }
      return "";
    });
  }

  /**
   * Hash the generated code for integrity verification
   */
  hashCode(code: string): string {
    return createHash("sha256").update(code).digest("hex");
  }
}

// Singleton instance
export const codeGenerator = new CodeGenerator();
