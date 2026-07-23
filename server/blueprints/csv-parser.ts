import type { 
  ParsedCMInstances, 
  CMInstanceRow, 
  ParsedUnitInstances, 
  UnitInstanceRow 
} from "./types";

/**
 * Parse a CSV string into rows
 */
function parseCSV(content: string): Array<Record<string, string>> {
  const lines = content.split("\n").filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(",").map(h => h.trim());
  const rows: Array<Record<string, string>> = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim());
    const row: Record<string, string> = {};
    
    headers.forEach((header, idx) => {
      row[header] = values[idx] || "";
    });
    
    // Skip empty rows
    if (row.Name || row.name) {
      rows.push(row);
    }
  }
  
  return rows;
}

/**
 * Parse Control Module instances CSV file
 * Example: PIDController.csv, AnalogValve.csv
 */
export function parseCMInstancesCSV(
  content: string, 
  cmTypeName: string,
  sourceFile?: string
): ParsedCMInstances {
  const rows = parseCSV(content);
  const instances: CMInstanceRow[] = [];
  
  // Standard columns that are not configuration
  const standardColumns = new Set([
    "name", "Name",
    "#", "instancenumber",
    "controller", "Controller",
    "unit instance", "Unit Instance", "unitinstance",
    "p&id drawing", "P&ID Drawing", "piddrawing",
    "comment", "Comment"
  ]);
  
  for (const row of rows) {
    const name = row.Name || row.name;
    if (!name) continue;
    
    // Extract configuration (non-standard columns)
    const configuration: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!standardColumns.has(key) && value) {
        // Try to parse numeric values
        const numValue = parseFloat(value);
        configuration[key] = isNaN(numValue) ? value : numValue;
      }
    }
    
    instances.push({
      name,
      instanceNumber: row["#"] ? parseInt(row["#"]) : undefined,
      controller: row.Controller || row.controller,
      unitInstance: row["Unit Instance"] || row["unit instance"],
      pidDrawing: row["P&ID Drawing"] || row["p&id drawing"],
      comment: row.Comment || row.comment,
      configuration,
    });
  }
  
  return {
    cmTypeName,
    instances,
    sourceFile,
  };
}

/**
 * Parse Unit instances CSV file
 * Example: Tank.csv, Reactor.csv
 */
export function parseUnitInstancesCSV(
  content: string,
  unitTypeName: string,
  sourceFile?: string
): ParsedUnitInstances {
  const rows = parseCSV(content);
  const instances: UnitInstanceRow[] = [];
  
  for (const row of rows) {
    const name = row.Name || row.name;
    if (!name) continue;
    
    instances.push({
      name,
      instanceNumber: row["#"] ? parseInt(row["#"]) : undefined,
      controller: row.Controller || row.controller,
      unitType: row["Unit Type"] || row["unit type"] || unitTypeName,
      pidDrawing: row["P&ID Drawing"] || row["p&id drawing"],
      processCell: row["Process Cell"] || row["process cell"],
      area: row.Area || row.area,
      comment: row.Comment || row.comment,
    });
  }
  
  return {
    unitTypeName,
    instances,
    sourceFile,
  };
}

/**
 * Extract CM type name from filename
 * Example: "PIDController.csv" -> "PIDController"
 */
export function extractCMTypeFromFilename(filename: string): string {
  return filename.replace(/\.csv$/i, "");
}

/**
 * Extract Unit type name from filename
 * Example: "Tank.csv" -> "Tank"
 */
export function extractUnitTypeFromFilename(filename: string): string {
  return filename.replace(/\.csv$/i, "");
}
