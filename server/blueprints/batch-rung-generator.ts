/**
 * Batch Rung Generator
 * Template-based rung generation with variable substitution
 * 
 * Ported from LadderLogix BatchRungGenerator for use in 0xSCADA
 * Enables generating multiple rung variants from templates and CSV data.
 */

import type { LadderRung, LadderTag } from "./ladder-logic-types";
import { parseNeutralText, rungToNeutralText } from "./neutral-text-generator";

export interface TemplateVariable {
  name: string;
  description?: string;
  defaultValue?: string;
  dataType?: string;
}

export interface BatchGenerationResult {
  success: boolean;
  rungs: LadderRung[];
  neutralText: string;
  generatedTags: LadderTag[];
  errors: string[];
  warnings: string[];
}

export interface TemplateValidationResult {
  valid: boolean;
  variables: string[];
  errors: string[];
  warnings: string[];
}

export interface CSVValidationResult {
  valid: boolean;
  csvVariables: string[];
  templateVariables: string[];
  missingVariables: string[];
  extraVariables: string[];
  rowCount: number;
  errors: string[];
  warnings: string[];
}

/**
 * Batch Rung Generator
 * Generates multiple ladder logic rungs from templates with variable substitution
 */
export class BatchRungGenerator {
  private template: string = "";
  private templateVariables: string[] = [];

  /**
   * Load a rung template with variable placeholders
   * Template should use {VariableName} or {{VariableName}} format
   */
  loadTemplate(template: string): void {
    this.template = template.trim();
    this.templateVariables = this.extractTemplateVariables();
  }

  /**
   * Get the current template
   */
  getTemplate(): string {
    return this.template;
  }

  /**
   * Extract variable names from template placeholders
   */
  extractTemplateVariables(): string[] {
    if (!this.template) return [];

    // Find all placeholders in format {VariableName} or {{VariableName}}
    const pattern = /\{\{?([A-Za-z_][A-Za-z0-9_]*)\}\}?/g;
    const variables = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(this.template)) !== null) {
      variables.add(match[1]);
    }

    return Array.from(variables);
  }

  /**
   * Validate the loaded template
   */
  validateTemplate(): TemplateValidationResult {
    const result: TemplateValidationResult = {
      valid: true,
      variables: [],
      errors: [],
      warnings: [],
    };

    if (!this.template) {
      result.valid = false;
      result.errors.push("No template loaded");
      return result;
    }

    // Extract variables
    result.variables = this.extractTemplateVariables();

    if (result.variables.length === 0) {
      result.warnings.push("No variables found in template");
    }

    // Check if template is valid neutral text format
    if (!this.template.includes(";") && !this.template.includes("{")) {
      result.warnings.push("Template may not be valid neutral text format (missing semicolon)");
    }

    // Check for balanced brackets
    const openBrackets = (this.template.match(/\[/g) || []).length;
    const closeBrackets = (this.template.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      result.valid = false;
      result.errors.push("Unbalanced brackets in template");
    }

    // Check for balanced parentheses
    const openParens = (this.template.match(/\(/g) || []).length;
    const closeParens = (this.template.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      result.valid = false;
      result.errors.push("Unbalanced parentheses in template");
    }

    return result;
  }

  /**
   * Parse CSV content into rows of variable mappings
   */
  parseCSV(csvContent: string): Record<string, string>[] {
    const lines = csvContent.trim().split("\n");
    if (lines.length < 2) return [];

    // Parse header
    const headers = this.parseCSVLine(lines[0]);
    const rows: Record<string, string>[] = [];

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (values.length === 0) continue;

      const row: Record<string, string> = {};
      for (let j = 0; j < headers.length && j < values.length; j++) {
        const key = headers[j].trim();
        const value = values[j].trim();
        if (key && value) {
          row[key] = value;
        }
      }

      if (Object.keys(row).length > 0) {
        rows.push(row);
      }
    }

    return rows;
  }

  /**
   * Parse a single CSV line handling quoted values
   */
  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    values.push(current);
    return values;
  }

  /**
   * Validate CSV content against template variables
   */
  validateCSV(csvContent: string): CSVValidationResult {
    const result: CSVValidationResult = {
      valid: true,
      csvVariables: [],
      templateVariables: this.templateVariables,
      missingVariables: [],
      extraVariables: [],
      rowCount: 0,
      errors: [],
      warnings: [],
    };

    try {
      const rows = this.parseCSV(csvContent);

      if (rows.length === 0) {
        result.valid = false;
        result.errors.push("CSV file is empty or has no data rows");
        return result;
      }

      result.rowCount = rows.length;

      // Get CSV variables from first row
      result.csvVariables = Object.keys(rows[0]);

      // Check for missing template variables
      const csvVarSet = new Set(result.csvVariables);
      for (const templateVar of this.templateVariables) {
        if (!csvVarSet.has(templateVar)) {
          result.missingVariables.push(templateVar);
        }
      }

      if (result.missingVariables.length > 0) {
        result.valid = false;
        result.errors.push(`CSV missing required variables: ${result.missingVariables.join(", ")}`);
      }

      // Check for extra CSV variables
      const templateVarSet = new Set(this.templateVariables);
      for (const csvVar of result.csvVariables) {
        if (!templateVarSet.has(csvVar)) {
          result.extraVariables.push(csvVar);
        }
      }

      if (result.extraVariables.length > 0) {
        result.warnings.push(`CSV has extra variables not in template: ${result.extraVariables.join(", ")}`);
      }
    } catch (error) {
      result.valid = false;
      result.errors.push(`Error parsing CSV: ${error}`);
    }

    return result;
  }

  /**
   * Generate a single rung by replacing template variables with values
   */
  generateRung(variableValues: Record<string, string>, rungNumber: number = 0): LadderRung {
    if (!this.template) {
      throw new Error("No template loaded");
    }

    let rungText = this.template;

    // Replace all occurrences of {VariableName} or {{VariableName}} with values
    for (const [varName, varValue] of Object.entries(variableValues)) {
      // Match {Var} or {{Var}}
      const pattern = new RegExp(`\\{\\{?${this.escapeRegex(varName)}\\}\\}?`, "g");
      rungText = rungText.replace(pattern, varValue);
    }

    // Ensure rung ends with semicolon
    rungText = rungText.trim();
    if (rungText && !rungText.endsWith(";")) {
      rungText += ";";
    }

    return parseNeutralText(rungText, rungNumber);
  }

  /**
   * Generate all rungs from CSV content
   */
  generateAll(csvContent: string): BatchGenerationResult {
    const result: BatchGenerationResult = {
      success: true,
      rungs: [],
      neutralText: "",
      generatedTags: [],
      errors: [],
      warnings: [],
    };

    // Validate template
    const templateValidation = this.validateTemplate();
    if (!templateValidation.valid) {
      result.success = false;
      result.errors.push(...templateValidation.errors);
      return result;
    }
    result.warnings.push(...templateValidation.warnings);

    // Validate CSV
    const csvValidation = this.validateCSV(csvContent);
    if (!csvValidation.valid) {
      result.success = false;
      result.errors.push(...csvValidation.errors);
      return result;
    }
    result.warnings.push(...csvValidation.warnings);

    // Parse CSV and generate rungs
    const rows = this.parseCSV(csvContent);
    const tagNames = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      try {
        const rung = this.generateRung(rows[i], i);
        result.rungs.push(rung);

        // Collect tag names from generated rung
        this.collectTagNames(rung, tagNames);
      } catch (error) {
        result.errors.push(`Error generating rung ${i}: ${error}`);
      }
    }

    // Generate neutral text
    result.neutralText = result.rungs
      .map(rung => rungToNeutralText(rung))
      .join("\n");

    // Generate tag list
    Array.from(tagNames).forEach(tagName => {
      result.generatedTags.push({
        name: tagName,
        dataType: this.inferTagDataType(tagName),
        scope: "program",
      });
    });

    result.success = result.errors.length === 0;
    return result;
  }

  /**
   * Collect tag names from a rung
   */
  private collectTagNames(rung: LadderRung, tagNames: Set<string>): void {
    for (const element of rung.elements) {
      this.collectElementTagNames(element, tagNames);
    }
  }

  /**
   * Collect tag names from an element
   */
  private collectElementTagNames(element: any, tagNames: Set<string>): void {
    if (element.type === "branch") {
      for (const path of element.paths) {
        for (const elem of path) {
          this.collectElementTagNames(elem, tagNames);
        }
      }
    } else if (element.parameters) {
      for (const param of element.parameters) {
        // Skip numeric literals
        if (!/^-?\d+(\.\d+)?$/.test(param)) {
          // Extract base tag name (before any dots or brackets)
          const baseName = param.split(/[.\[]/)[0];
          if (baseName && /^[A-Za-z_]/.test(baseName)) {
            tagNames.add(baseName);
          }
        }
      }
    }
  }

  /**
   * Infer data type from tag name
   */
  private inferTagDataType(tagName: string): string {
    const lowerName = tagName.toLowerCase();

    if (lowerName.includes("timer") || lowerName.endsWith("_tmr")) {
      return "TIMER";
    }
    if (lowerName.includes("counter") || lowerName.endsWith("_cnt")) {
      return "COUNTER";
    }
    if (lowerName.includes("value") || lowerName.includes("setpoint") || lowerName.includes("sp")) {
      return "REAL";
    }
    if (lowerName.includes("count") || lowerName.includes("index") || lowerName.includes("step")) {
      return "DINT";
    }

    // Default to BOOL for most tags
    return "BOOL";
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Create a template from example rungs
   * Identifies common patterns and creates a parameterized template
   */
  static createTemplateFromExamples(examples: string[]): { template: string; variables: TemplateVariable[] } {
    if (examples.length === 0) {
      return { template: "", variables: [] };
    }

    if (examples.length === 1) {
      // Single example - identify potential variables (tag names)
      const template = examples[0];
      const variables: TemplateVariable[] = [];

      // Find tag names in instructions
      const tagPattern = /\(([A-Za-z_][A-Za-z0-9_]*)\)/g;
      const seen = new Set<string>();
      let match: RegExpExecArray | null;

      while ((match = tagPattern.exec(template)) !== null) {
        const tagName = match[1];
        if (!seen.has(tagName)) {
          seen.add(tagName);
          variables.push({
            name: tagName,
            description: `Tag: ${tagName}`,
            dataType: "BOOL",
          });
        }
      }

      return { template, variables };
    }

    // Multiple examples - find common structure and differences
    // This is a simplified implementation
    const firstExample = examples[0];
    let template = firstExample;
    const variables: TemplateVariable[] = [];
    let varIndex = 0;

    // Compare with other examples to find varying parts
    for (let i = 1; i < examples.length; i++) {
      const example = examples[i];
      // Find differences and replace with variables
      // This is a basic implementation - real version would use diff algorithm
    }

    return { template, variables };
  }
}

// Export singleton instance
export const batchRungGenerator = new BatchRungGenerator();
