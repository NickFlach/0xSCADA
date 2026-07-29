import type { ParsedCMType, CMTypeInput, CMTypeOutput, CMTypeInOut } from "./types";
import logger from "../logger";

/**
 * Parses a Control Module Type markdown file from the blueprints format.
 * Example: cm-type-PIDController.md, cm-type-AnalogValve.md
 */
export function parseCMTypeMarkdown(content: string, sourceFile?: string): ParsedCMType | null {
  const lines = content.split("\n");
  
  // Extract CM Type name from header
  // `[^\S\n]` not `\s`: `\s` matches newlines, so the header could span lines
  // and the trailing run could overlap the capture, giving an uploaded file a
  // quadratic match. The capture starts straight after the colon and `.trim()`
  // below strips the leading run exactly as the old `\s*` did.
  const nameMatch = content.match(/^#[^\S\n]*CM[^\S\n]*TYPE:(.+)$/m);
  if (!nameMatch) {
    logger.warn(
      { sourceFile },
      "Could not find CM TYPE header in blueprint file",
    );
    return null;
  }
  
  const name = nameMatch[1].trim();
  const inputs: CMTypeInput[] = [];
  const outputs: CMTypeOutput[] = [];
  const inOuts: CMTypeInOut[] = [];
  
  let currentSection: "inputs" | "outputs" | "inouts" | null = null;
  let headerRow: string[] = [];
  let inTable = false;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Detect section headers
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
    if (trimmedLine.match(/^##\s/)) {
      // Another section, stop parsing current
      currentSection = null;
      inTable = false;
      continue;
    }
    
    if (!currentSection) continue;
    
    // Parse markdown table
    if (trimmedLine.startsWith("|")) {
      const cells = trimmedLine
        .split("|")
        .map(c => c.trim())
        .filter(c => c.length > 0);
      
      if (!inTable) {
        // First row is header
        headerRow = cells.map(c => c.toLowerCase());
        inTable = true;
        continue;
      }
      
      // Skip separator row (contains dashes)
      if (cells.every(c => c.match(/^[-:]+$/))) {
        continue;
      }
      
      // Parse data row
      const row: Record<string, string> = Object.create(null); // null-prototype: header cells are untrusted keys
      headerRow.forEach((header, idx) => {
        row[header] = cells[idx] || "";
      });
      
      if (!row.name) continue;
      
      const item = {
        name: row.name,
        suffix: row.suffix || undefined,
        dataType: row.datatype || row["data type"] || "Bool",
        ioType: row["io type"] || row.iotype || undefined,
        comment: row.comment || undefined,
        primary: row.primary?.toLowerCase() === "true",
        isError: row.iserror?.toLowerCase() === "true",
        configurable: row.configurable?.toLowerCase() === "true",
        trueWords: row["true words"] || row.truewords || undefined,
        falseWords: row["false words"] || row.falsewords || undefined,
        loopback: row.loopback?.toLowerCase() === "true",
        enumType: row.enum || undefined,
      };
      
      if (currentSection === "inputs") {
        inputs.push(item as CMTypeInput);
      } else if (currentSection === "outputs") {
        outputs.push(item as CMTypeOutput);
      } else if (currentSection === "inouts") {
        inOuts.push(item as CMTypeInOut);
      }
    }
  }
  
  return {
    name,
    inputs,
    outputs,
    inOuts,
    sourceFile,
  };
}

/**
 * Parse multiple CM Type files from a directory listing
 */
export function parseCMTypeFiles(files: Array<{ name: string; content: string }>): ParsedCMType[] {
  const results: ParsedCMType[] = [];
  
  for (const file of files) {
    if (!file.name.startsWith("cm-type-") || !file.name.endsWith(".md")) {
      continue;
    }
    
    const parsed = parseCMTypeMarkdown(file.content, file.name);
    if (parsed) {
      results.push(parsed);
    }
  }
  
  return results;
}
