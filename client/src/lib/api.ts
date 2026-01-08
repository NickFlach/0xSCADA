import type { 
  Site, 
  Asset, 
  EventAnchor, 
  MaintenanceRecord,
  ControlModuleType,
  UnitType,
  PhaseType,
  Vendor,
  TemplatePackage,
  GeneratedCode,
  Controller
} from "@shared/schema";

const API_BASE = "/api";

// ============================================================================
// CORE SCADA API
// ============================================================================

export async function fetchSites(): Promise<Site[]> {
  const response = await fetch(`${API_BASE}/sites`);
  if (!response.ok) throw new Error("Failed to fetch sites");
  return response.json();
}

export async function fetchAssets(): Promise<Asset[]> {
  const response = await fetch(`${API_BASE}/assets`);
  if (!response.ok) throw new Error("Failed to fetch assets");
  return response.json();
}

export async function fetchEvents(limit: number = 100): Promise<EventAnchor[]> {
  const response = await fetch(`${API_BASE}/events?limit=${limit}`);
  if (!response.ok) throw new Error("Failed to fetch events");
  return response.json();
}

export async function fetchMaintenanceRecords(): Promise<MaintenanceRecord[]> {
  const response = await fetch(`${API_BASE}/maintenance`);
  if (!response.ok) throw new Error("Failed to fetch maintenance records");
  return response.json();
}

// ============================================================================
// BLUEPRINTS API
// ============================================================================

export async function fetchControlModuleTypes(): Promise<ControlModuleType[]> {
  const response = await fetch(`${API_BASE}/blueprints/cm-types`);
  if (!response.ok) throw new Error("Failed to fetch control module types");
  return response.json();
}

export async function fetchUnitTypes(): Promise<UnitType[]> {
  const response = await fetch(`${API_BASE}/blueprints/unit-types`);
  if (!response.ok) throw new Error("Failed to fetch unit types");
  return response.json();
}

export async function fetchPhaseTypes(): Promise<PhaseType[]> {
  const response = await fetch(`${API_BASE}/blueprints/phase-types`);
  if (!response.ok) throw new Error("Failed to fetch phase types");
  return response.json();
}

export async function fetchBlueprintsSummary(): Promise<{
  controlModuleTypes: number;
  controlModuleInstances: number;
  unitTypes: number;
  unitInstances: number;
  phaseTypes: number;
  phaseInstances: number;
  vendors: number;
  templates: number;
}> {
  const response = await fetch(`${API_BASE}/blueprints/summary`);
  if (!response.ok) throw new Error("Failed to fetch blueprints summary");
  return response.json();
}

export async function createControlModuleType(data: Partial<ControlModuleType>): Promise<ControlModuleType> {
  const response = await fetch(`${API_BASE}/blueprints/cm-types`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error("Failed to create control module type");
  return response.json();
}

// ============================================================================
// VENDORS API
// ============================================================================

export async function fetchVendors(): Promise<Vendor[]> {
  const response = await fetch(`${API_BASE}/vendors`);
  if (!response.ok) throw new Error("Failed to fetch vendors");
  return response.json();
}

export async function fetchTemplates(): Promise<TemplatePackage[]> {
  const response = await fetch(`${API_BASE}/templates`);
  if (!response.ok) throw new Error("Failed to fetch templates");
  return response.json();
}

export async function fetchTemplatesByVendor(vendorId: string): Promise<TemplatePackage[]> {
  const response = await fetch(`${API_BASE}/templates/vendor/${vendorId}`);
  if (!response.ok) throw new Error("Failed to fetch vendor templates");
  return response.json();
}

export async function fetchControllers(): Promise<Controller[]> {
  const response = await fetch(`${API_BASE}/controllers`);
  if (!response.ok) throw new Error("Failed to fetch controllers");
  return response.json();
}

// ============================================================================
// CODE GENERATION API
// ============================================================================

export async function fetchGeneratedCode(): Promise<GeneratedCode[]> {
  const response = await fetch(`${API_BASE}/generated-code`);
  if (!response.ok) throw new Error("Failed to fetch generated code");
  return response.json();
}

export async function generateControlModuleCode(
  cmTypeId: string,
  vendorId: string,
  options?: { instanceName?: string; format?: string }
): Promise<{ success: boolean; id: string; code: string; codeHash: string; language: string; vendor: string }> {
  const response = await fetch(`${API_BASE}/generate/control-module/${cmTypeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vendorId, ...options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to generate code");
  }
  return response.json();
}

export async function generatePhaseCode(
  phaseTypeId: string,
  vendorId: string,
  options?: { instanceName?: string; format?: string }
): Promise<{ success: boolean; id: string; code: string; codeHash: string; language: string; vendor: string }> {
  const response = await fetch(`${API_BASE}/generate/phase/${phaseTypeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vendorId, ...options }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to generate phase code");
  }
  return response.json();
}

export async function anchorGeneratedCode(codeId: string): Promise<{ success: boolean; txHash?: string }> {
  const response = await fetch(`${API_BASE}/generated-code/${codeId}/anchor`, {
    method: "POST",
  });
  if (!response.ok) throw new Error("Failed to anchor code");
  return response.json();
}

// ============================================================================
// DATABASE SEEDING
// ============================================================================

export async function seedDatabase(): Promise<{ 
  success: boolean; 
  vendors: number; 
  dataTypeMappings: number; 
  templatePackages: number; 
  errors: string[] 
}> {
  const response = await fetch(`${API_BASE}/blueprints/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error("Failed to seed database");
  return response.json();
}

// ============================================================================
// LADDER LOGIC GENERATION API
// ============================================================================

export interface LadderLogicResult {
  success: boolean;
  id: string;
  code: string;
  visualDiagram: string;
  codeHash: string;
  language: string;
  routines: Array<{
    name: string;
    type: string;
    neutralText: string;
  }>;
  tags: Array<{
    name: string;
    dataType: string;
    scope: string;
    description?: string;
  }>;
  metadata: {
    generatedAt: string;
    rungCount: number;
    instructionCount: number;
  };
  warnings: string[];
}

export async function generateLadderLogicForControlModule(
  cmTypeId: string,
  options?: { 
    includeComments?: boolean; 
    generateFaultHandling?: boolean; 
    generateInterlocks?: boolean 
  }
): Promise<LadderLogicResult> {
  const response = await fetch(`${API_BASE}/generate/ladder-logic/control-module/${cmTypeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options || {}),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to generate ladder logic");
  }
  return response.json();
}

export async function generateLadderLogicForPhase(
  phaseTypeId: string,
  options?: { 
    includeComments?: boolean; 
    generateFaultHandling?: boolean; 
    generateInterlocks?: boolean 
  }
): Promise<LadderLogicResult> {
  const response = await fetch(`${API_BASE}/generate/ladder-logic/phase/${phaseTypeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options || {}),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to generate phase ladder logic");
  }
  return response.json();
}

export async function fetchInstructionLibrary(category?: string): Promise<Record<string, any>> {
  const url = category 
    ? `${API_BASE}/ladder-logic/instructions?category=${category}`
    : `${API_BASE}/ladder-logic/instructions`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to fetch instruction library");
  return response.json();
}

export async function generateBatchRungs(
  template: string,
  csvContent?: string,
  startRungNumber?: number
): Promise<{
  success: boolean;
  neutralText?: string;
  rungCount?: number;
  variables?: string[];
  errors?: string[];
  warnings?: string[];
}> {
  const response = await fetch(`${API_BASE}/ladder-logic/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template, csvContent, startRungNumber }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to generate batch rungs");
  }
  return response.json();
}

export async function getAIPromptContext(cmTypeId: string): Promise<{
  success: boolean;
  cmTypeName: string;
  aiPrompt: string;
  context: {
    sourceType: string;
    sourceName: string;
    inputCount: number;
    outputCount: number;
  };
}> {
  const response = await fetch(`${API_BASE}/ladder-logic/ai-context/${cmTypeId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to generate AI context");
  }
  return response.json();
}
