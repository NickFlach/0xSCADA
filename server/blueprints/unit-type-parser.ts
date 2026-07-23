import type { ParsedUnitType, UnitTypeVariable } from "./types";

/**
 * Parses a Unit Type markdown file from the blueprints format.
 * Example: unit-type-Tank.md, unit-type-Reactor.md
 */
export function parseUnitTypeMarkdown(content: string, sourceFile?: string): ParsedUnitType | null {
  const lines = content.split("\n");
  
  // Extract Unit Type name from header
  const nameMatch = content.match(/^#\s*UNIT\s*TYPE:\s*(.+)$/m);
  if (!nameMatch) {
    console.warn(`Could not find UNIT TYPE header in ${sourceFile}`);
    return null;
  }
  
  const name = nameMatch[1].trim();
  let description: string | undefined;
  const variables: UnitTypeVariable[] = [];
  
  let currentSection: "description" | "variables" | null = null;
  let headerRow: string[] = [];
  let inTable = false;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Detect section headers
    if (trimmedLine.match(/^##\s*Description\s*$/i)) {
      currentSection = "description";
      continue;
    }
    if (trimmedLine.match(/^##\s*Unit\s*Type\s*Specific\s*Variables\s*$/i)) {
      currentSection = "variables";
      inTable = false;
      headerRow = [];
      continue;
    }
    if (trimmedLine.match(/^##\s/)) {
      currentSection = null;
      inTable = false;
      continue;
    }
    
    // Parse description (plain text after ## Description)
    if (currentSection === "description" && trimmedLine && !trimmedLine.startsWith("#")) {
      description = (description ? description + " " : "") + trimmedLine;
      continue;
    }
    
    // Parse variables table
    if (currentSection === "variables" && trimmedLine.startsWith("|")) {
      const cells = trimmedLine
        .split("|")
        .map(c => c.trim())
        .filter(c => c.length > 0);
      
      if (!inTable) {
        headerRow = cells.map(c => c.toLowerCase());
        inTable = true;
        continue;
      }
      
      // Skip separator row
      if (cells.every(c => c.match(/^[-:]+$/))) {
        continue;
      }
      
      // Parse data row
      const row: Record<string, string> = {};
      headerRow.forEach((header, idx) => {
        row[header] = cells[idx] || "";
      });
      
      if (!row.name) continue;
      
      variables.push({
        name: row.name,
        dataType: row.datatype || row["data type"] || "Real",
        comment: row.comment || undefined,
        unit: row.unit || undefined,
        enumType: row.enum || undefined,
      });
    }
  }
  
  return {
    name,
    description,
    variables,
    sourceFile,
  };
}

/**
 * Parse multiple Unit Type files
 */
export function parseUnitTypeFiles(files: Array<{ name: string; content: string }>): ParsedUnitType[] {
  const results: ParsedUnitType[] = [];
  
  for (const file of files) {
    if (!file.name.startsWith("unit-type-") || !file.name.endsWith(".md")) {
      continue;
    }
    
    const parsed = parseUnitTypeMarkdown(file.content, file.name);
    if (parsed) {
      results.push(parsed);
    }
  }
  
  return results;
}
