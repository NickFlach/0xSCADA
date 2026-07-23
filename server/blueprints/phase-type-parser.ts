import type { 
  ParsedPhaseType, 
  PhaseLinkedModule, 
  PhaseVariable, 
  PhaseSequence,
  PhaseSequenceStep 
} from "./types";

/**
 * Parses a Phase Type markdown file from the blueprints format.
 * Example: phase-type-DemoPhase.md
 */
export function parsePhaseTypeMarkdown(content: string, sourceFile?: string): ParsedPhaseType | null {
  const lines = content.split("\n");
  
  // Extract Phase Type name from header
  const nameMatch = content.match(/^#\s*PHASE\s*TYPE:\s*(.+)$/m);
  if (!nameMatch) {
    console.warn(`Could not find PHASE TYPE header in ${sourceFile}`);
    return null;
  }
  
  const name = nameMatch[1].trim();
  let description: string | undefined;
  const linkedModules: PhaseLinkedModule[] = [];
  const inputs: PhaseVariable[] = [];
  const outputs: PhaseVariable[] = [];
  const inOuts: PhaseVariable[] = [];
  const internalValues: PhaseVariable[] = [];
  const hmiParameters: PhaseVariable[] = [];
  const recipeParameters: PhaseVariable[] = [];
  const reportParameters: PhaseVariable[] = [];
  const sequences: Record<string, PhaseSequence> = {};
  
  type SectionType = 
    | "description" 
    | "linked_modules" 
    | "inputs" 
    | "outputs" 
    | "inouts"
    | "internal_values"
    | "hmi_parameters"
    | "recipe_parameters"
    | "report_parameters"
    | "idle_state"
    | "starting_state"
    | "running_state"
    | "pausing_state"
    | "holding_state"
    | "aborting_state"
    | "completing_state"
    | null;
  
  let currentSection: SectionType = null;
  let headerRow: string[] = [];
  let inTable = false;
  let currentSequenceName = "";
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    
    // Detect section headers
    if (trimmedLine.match(/^##\s*Description\s*$/i)) {
      currentSection = "description";
      inTable = false;
      continue;
    }
    if (trimmedLine.match(/^##\s*Linked\s*Modules\s*$/i)) {
      currentSection = "linked_modules";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Inputs\s*$/i)) {
      currentSection = "inputs";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Outputs\s*$/i)) {
      currentSection = "outputs";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*InOuts\s*$/i)) {
      currentSection = "inouts";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Internal\s*Values\s*$/i)) {
      currentSection = "internal_values";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*HMI\s*Parameters\s*$/i)) {
      currentSection = "hmi_parameters";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Recipe\s*Parameters\s*$/i)) {
      currentSection = "recipe_parameters";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Report\s*Parameters\s*$/i)) {
      currentSection = "report_parameters";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Idle\s*State\s*$/i)) {
      currentSection = "idle_state";
      currentSequenceName = "Idle";
      sequences[currentSequenceName] = { name: currentSequenceName, steps: [] };
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Starting\s*State\s*$/i)) {
      currentSection = "starting_state";
      currentSequenceName = "Starting";
      sequences[currentSequenceName] = { name: currentSequenceName, steps: [] };
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s*Running\s*State\s*$/i)) {
      currentSection = "running_state";
      currentSequenceName = "Running";
      sequences[currentSequenceName] = { name: currentSequenceName, steps: [] };
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s/)) {
      currentSection = null;
      inTable = false;
      continue;
    }
    
    // Parse description
    if (currentSection === "description" && trimmedLine && !trimmedLine.startsWith("#") && !trimmedLine.startsWith("|")) {
      description = (description ? description + " " : "") + trimmedLine;
      continue;
    }
    
    // Parse tables
    if (trimmedLine.startsWith("|")) {
      const cells = trimmedLine
        .split("|")
        .map(c => c.trim())
        .filter(c => c.length > 0);
      
      if (!inTable) {
        headerRow = cells.map(c => c.toLowerCase().replace(/\s+/g, ""));
        inTable = true;
        continue;
      }
      
      // Skip separator row
      if (cells.every(c => c.match(/^[-:]+$/))) {
        continue;
      }
      
      // Parse data row based on section
      const row: Record<string, string> = {};
      headerRow.forEach((header, idx) => {
        row[header] = cells[idx] || "";
      });
      
      if (currentSection === "linked_modules" && row.name) {
        linkedModules.push({
          name: row.name,
          type: row.type || "",
          dynamic: row.dynamic?.toLowerCase() === "true",
          connectionType: row.connectiontype || row["connection type"],
          comment: row.comment,
        });
      }
      
      if (currentSection === "inputs" && row.name) {
        inputs.push(parsePhaseVariable(row));
      }
      
      if (currentSection === "outputs" && row.name) {
        outputs.push(parsePhaseVariable(row));
      }
      
      if (currentSection === "inouts" && row.name) {
        inOuts.push(parsePhaseVariable(row));
      }
      
      if (currentSection === "internal_values" && row.name) {
        internalValues.push(parsePhaseVariable(row));
      }
      
      if (currentSection === "hmi_parameters" && row.name) {
        hmiParameters.push(parsePhaseVariable(row));
      }
      
      if (currentSection === "recipe_parameters" && row.name) {
        recipeParameters.push(parsePhaseVariable(row));
      }
      
      if (currentSection === "report_parameters" && row.name) {
        reportParameters.push(parsePhaseVariable(row));
      }
      
      // Parse sequence steps
      if (currentSequenceName && sequences[currentSequenceName]) {
        const stepNum = parseInt(row.step);
        if (!isNaN(stepNum)) {
          const actions = (row.actions || "")
            .split("\n")
            .map(a => a.trim())
            .filter(a => a && !a.startsWith("#") && !a.startsWith("//"));
          
          const conditionsRaw = row.conditions || "";
          const targetRaw = row.target || "";
          
          // Parse conditions and targets (simplified)
          const conditions: Array<{ condition: string; target: number }> = [];
          const targetNum = parseInt(targetRaw);
          if (!isNaN(targetNum) && conditionsRaw) {
            conditions.push({
              condition: conditionsRaw.replace(/^#.*$/gm, "").trim(),
              target: targetNum,
            });
          }
          
          sequences[currentSequenceName].steps.push({
            step: stepNum,
            actions,
            conditions,
          });
        }
      }
    }
  }
  
  return {
    name,
    description,
    linkedModules,
    inputs,
    outputs,
    inOuts,
    internalValues,
    hmiParameters,
    recipeParameters,
    reportParameters,
    sequences,
    sourceFile,
  };
}

function parsePhaseVariable(row: Record<string, string>): PhaseVariable {
  return {
    name: row.name,
    dataType: row.datatype || "Bool",
    comment: row.comment,
    defaultFromInstance: row.defaultfrominstance?.toLowerCase() === "true",
    unit: row.unit,
    enumType: row.enum,
    min: row.min ? parseFloat(row.min) : undefined,
    max: row.max ? parseFloat(row.max) : undefined,
    defaultValue: row.default,
  };
}

/**
 * Parse multiple Phase Type files
 */
export function parsePhaseTypeFiles(files: Array<{ name: string; content: string }>): ParsedPhaseType[] {
  const results: ParsedPhaseType[] = [];
  
  for (const file of files) {
    if (!file.name.startsWith("phase-type-") || !file.name.endsWith(".md")) {
      continue;
    }
    
    const parsed = parsePhaseTypeMarkdown(file.content, file.name);
    if (parsed) {
      results.push(parsed);
    }
  }
  
  return results;
}
