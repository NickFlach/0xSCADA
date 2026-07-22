import { parseCMTypeMarkdown } from "./cm-type-parser";
import { parseCMInstancesCSV, parseUnitInstancesCSV, extractCMTypeFromFilename, extractUnitTypeFromFilename } from "./csv-parser";
import { parseUnitTypeMarkdown } from "./unit-type-parser";
import { parsePhaseTypeMarkdown } from "./phase-type-parser";
import type { 
  BlueprintImportResult, 
  ParsedCMType, 
  ParsedCMInstances,
  ParsedUnitType,
  ParsedUnitInstances,
  ParsedPhaseType 
} from "./types";

export interface BlueprintFiles {
  cmTypePackage: Array<{ name: string; content: string }>;
  designSpec: {
    cmInstances: Array<{ name: string; content: string }>;
    unitTypes: Array<{ name: string; content: string }>;
    unitInstances: Array<{ name: string; content: string }>;
    phaseTypes: Array<{ name: string; content: string }>;
  };
}

/**
 * Import a complete blueprints package
 */
export function importBlueprints(files: BlueprintFiles): BlueprintImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cmTypes: ParsedCMType[] = [];
  const cmInstances: ParsedCMInstances[] = [];
  const unitTypes: ParsedUnitType[] = [];
  const unitInstances: ParsedUnitInstances[] = [];
  const phaseTypes: ParsedPhaseType[] = [];

  // Parse CM Types
  for (const file of files.cmTypePackage) {
    if (file.name.startsWith("cm-type-") && file.name.endsWith(".md")) {
      try {
        const parsed = parseCMTypeMarkdown(file.content, file.name);
        if (parsed) {
          cmTypes.push(parsed);
        } else {
          warnings.push(`Could not parse CM Type from ${file.name}`);
        }
      } catch (err) {
        errors.push(`Error parsing ${file.name}: ${err}`);
      }
    }
  }

  // Parse Unit Types
  for (const file of files.designSpec.unitTypes) {
    if (file.name.startsWith("unit-type-") && file.name.endsWith(".md")) {
      try {
        const parsed = parseUnitTypeMarkdown(file.content, file.name);
        if (parsed) {
          unitTypes.push(parsed);
        } else {
          warnings.push(`Could not parse Unit Type from ${file.name}`);
        }
      } catch (err) {
        errors.push(`Error parsing ${file.name}: ${err}`);
      }
    }
  }

  // Parse Phase Types
  for (const file of files.designSpec.phaseTypes) {
    if (file.name.startsWith("phase-type-") && file.name.endsWith(".md")) {
      try {
        const parsed = parsePhaseTypeMarkdown(file.content, file.name);
        if (parsed) {
          phaseTypes.push(parsed);
        } else {
          warnings.push(`Could not parse Phase Type from ${file.name}`);
        }
      } catch (err) {
        errors.push(`Error parsing ${file.name}: ${err}`);
      }
    }
  }

  // Parse CM Instances
  for (const file of files.designSpec.cmInstances) {
    if (file.name.endsWith(".csv")) {
      try {
        const cmTypeName = extractCMTypeFromFilename(file.name);
        const parsed = parseCMInstancesCSV(file.content, cmTypeName, file.name);
        if (parsed.instances.length > 0) {
          cmInstances.push(parsed);
        }
      } catch (err) {
        errors.push(`Error parsing ${file.name}: ${err}`);
      }
    }
  }

  // Parse Unit Instances
  for (const file of files.designSpec.unitInstances) {
    if (file.name.endsWith(".csv")) {
      try {
        const unitTypeName = extractUnitTypeFromFilename(file.name);
        const parsed = parseUnitInstancesCSV(file.content, unitTypeName, file.name);
        if (parsed.instances.length > 0) {
          unitInstances.push(parsed);
        }
      } catch (err) {
        errors.push(`Error parsing ${file.name}: ${err}`);
      }
    }
  }

  return {
    success: errors.length === 0,
    cmTypes,
    cmInstances,
    unitTypes,
    unitInstances,
    phaseTypes,
    errors,
    warnings,
  };
}

/**
 * Validate that CM instances reference valid CM types
 */
export function validateCMReferences(
  cmTypes: ParsedCMType[], 
  cmInstances: ParsedCMInstances[]
): string[] {
  const errors: string[] = [];
  const typeNames = new Set(cmTypes.map(t => t.name));

  for (const instanceGroup of cmInstances) {
    if (!typeNames.has(instanceGroup.cmTypeName)) {
      errors.push(
        `CM instances in ${instanceGroup.sourceFile} reference unknown CM type: ${instanceGroup.cmTypeName}`
      );
    }
  }

  return errors;
}

/**
 * Validate that Unit instances reference valid Unit types
 */
export function validateUnitReferences(
  unitTypes: ParsedUnitType[],
  unitInstances: ParsedUnitInstances[]
): string[] {
  const errors: string[] = [];
  const typeNames = new Set(unitTypes.map(t => t.name));

  for (const instanceGroup of unitInstances) {
    if (!typeNames.has(instanceGroup.unitTypeName)) {
      errors.push(
        `Unit instances in ${instanceGroup.sourceFile} reference unknown Unit type: ${instanceGroup.unitTypeName}`
      );
    }
  }

  return errors;
}

/**
 * Validate that Phase types reference valid CM types
 */
export function validatePhaseReferences(
  cmTypes: ParsedCMType[],
  phaseTypes: ParsedPhaseType[]
): string[] {
  const errors: string[] = [];
  const typeNames = new Set(cmTypes.map(t => t.name));

  for (const phase of phaseTypes) {
    for (const module of phase.linkedModules) {
      if (!typeNames.has(module.type)) {
        errors.push(
          `Phase ${phase.name} references unknown CM type: ${module.type}`
        );
      }
    }
  }

  return errors;
}
