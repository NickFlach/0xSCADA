import { loadConfig, type Config } from "./config.js";

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  version: string;
  uptime: number;
  components: {
    database: {
      status: string;
      latencyMs?: number;
    };
    blockchain: {
      status: string;
    };
  };
  error?: string;
}

export interface Site {
  id: string;
  name: string;
  location: string;
  owner: string;
  createdAt: string;
}

export interface Asset {
  id: string;
  siteId: string;
  assetType: string;
  nameOrTag: string;
  critical: boolean;
  createdAt: string;
}

export interface EventAnchor {
  id: string;
  assetId: string;
  eventType: string;
  payloadHash: string;
  timestamp: string;
  recordedBy: string;
  txHash: string | null;
  details: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface BatchStats {
  pendingEvents: number;
  totalBatchesAnchored: number;
  totalEventsAnchored: number;
  lastBatchTime: string | null;
  averageEventsPerBatch: number;
  estimatedGasSavings: number;
}

export interface BlueprintsSummary {
  controlModuleTypes: number;
  controlModuleInstances: number;
  unitTypes: number;
  unitInstances: number;
  phaseTypes: number;
  phaseInstances: number;
  vendors: number;
}

export interface Agent {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  agentType?: string;
  status?: string;
  version?: string;
  publicKey?: string;
  capabilities?: string[];
  scope?: {
    allSites?: boolean;
    siteIds?: string[];
    allAssets?: boolean;
    assetIds?: string[];
    allEventTypes?: boolean;
    eventTypes?: string[];
  };
  createdAt: string;
  updatedAt?: string;
  lastActiveAt?: string;
  lastError?: string;
}

export interface AgentProposal {
  id: string;
  agentId: string;
  proposalType?: string;
  title?: string;
  description?: string;
  action?: unknown;
  reasoning?: string;
  confidence?: number;
  riskLevel?: string;
  riskFactors?: string[];
  status?: string;
  requiredApprovals?: number;
  approvals?: Array<{
    userId: string;
    userName: string;
    decision: string;
    comment?: string;
    decidedAt: string;
  }>;
  createdAt: string;
  expiresAt?: string;
  executedAt?: string;
}

export interface AgentLog {
  timestamp: string;
  level: string;
  message: string;
}

export interface AgentStateEntry {
  key: string;
  value: unknown;
  updatedAt?: string;
  expiresAt?: string;
}

export class ApiClient {
  private config: Config;

  constructor(config?: Partial<Config>) {
    this.config = { ...loadConfig(), ...config };
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.config.apiUrl}${endpoint}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as T & { error?: string };

      if (!response.ok) {
        return {
          success: false,
          error: (data as { error?: string }).error || `HTTP ${response.status}`,
          statusCode: response.status,
        };
      }

      return {
        success: true,
        data: data as T,
        statusCode: response.status,
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          return {
            success: false,
            error: "Request timed out",
          };
        }
        return {
          success: false,
          error: error.message,
        };
      }
      return {
        success: false,
        error: "Unknown error occurred",
      };
    }
  }

  // Health & Status
  async getHealth(): Promise<ApiResponse<HealthResponse>> {
    return this.request<HealthResponse>("/api/health");
  }

  async getBlockchainStatus(): Promise<ApiResponse<{ enabled: boolean }>> {
    return this.request<{ enabled: boolean }>("/api/blockchain/status");
  }

  // Sites
  async getSites(): Promise<ApiResponse<Site[]>> {
    return this.request<Site[]>("/api/sites");
  }

  async getSiteById(id: string): Promise<ApiResponse<Site>> {
    const response = await this.getSites();
    if (!response.success || !response.data) {
      return { success: false, error: response.error || "Failed to fetch sites" };
    }
    const site = response.data.find((s) => s.id === id);
    if (!site) {
      return { success: false, error: `Site with ID '${id}' not found` };
    }
    return { success: true, data: site };
  }

  async createSite(site: Omit<Site, "id" | "createdAt">): Promise<ApiResponse<Site>> {
    return this.request<Site>("/api/sites", {
      method: "POST",
      body: JSON.stringify(site),
    });
  }

  // Assets
  async getAssets(): Promise<ApiResponse<Asset[]>> {
    return this.request<Asset[]>("/api/assets");
  }

  async getAssetById(id: string): Promise<ApiResponse<Asset>> {
    const response = await this.getAssets();
    if (!response.success || !response.data) {
      return { success: false, error: response.error || "Failed to fetch assets" };
    }
    const asset = response.data.find((a) => a.id === id);
    if (!asset) {
      return { success: false, error: `Asset with ID '${id}' not found` };
    }
    return { success: true, data: asset };
  }

  async getAssetsBySite(siteId: string): Promise<ApiResponse<Asset[]>> {
    return this.request<Asset[]>(`/api/assets/site/${siteId}`);
  }

  async createAsset(asset: Omit<Asset, "id" | "createdAt">): Promise<ApiResponse<Asset>> {
    return this.request<Asset>("/api/assets", {
      method: "POST",
      body: JSON.stringify(asset),
    });
  }

  // Events
  async getEvents(
    page = 1,
    limit = 50
  ): Promise<ApiResponse<PaginatedResponse<EventAnchor>>> {
    return this.request<PaginatedResponse<EventAnchor>>(
      `/api/events?page=${page}&limit=${limit}`
    );
  }

  async createEvent(event: {
    assetId: string;
    eventType: string;
    payload: unknown;
    details?: string;
    recordedBy?: string;
  }): Promise<ApiResponse<EventAnchor>> {
    return this.request<EventAnchor>("/api/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  // Batch Anchoring
  async getBatchStats(): Promise<ApiResponse<BatchStats>> {
    return this.request<BatchStats>("/api/batch/stats");
  }

  async triggerBatchAnchor(): Promise<
    ApiResponse<{
      success: boolean;
      message: string;
      batchId?: string;
      txHash?: string;
      eventCount?: number;
    }>
  > {
    return this.request("/api/batch/trigger", {
      method: "POST",
    });
  }

  // Blueprints
  async getBlueprintsSummary(): Promise<ApiResponse<BlueprintsSummary>> {
    return this.request<BlueprintsSummary>("/api/blueprints/summary");
  }

  async seedDatabase(force = false): Promise<
    ApiResponse<{
      success: boolean;
      message?: string;
      skipped?: boolean;
    }>
  > {
    return this.request(`/api/blueprints/seed${force ? "?force=true" : ""}`, {
      method: "POST",
    });
  }

  // Vendors
  async getVendors(): Promise<
    ApiResponse<
      Array<{
        id: string;
        name: string;
        displayName: string;
      }>
    >
  > {
    return this.request("/api/vendors");
  }

  // Controllers
  async getControllers(): Promise<
    ApiResponse<
      Array<{
        id: string;
        name: string;
        vendorId: string;
        siteId?: string;
        ipAddress?: string;
      }>
    >
  > {
    return this.request("/api/controllers");
  }

  // Blueprints - CM Types
  async getCMTypes(): Promise<ApiResponse<CMType[]>> {
    return this.request<CMType[]>("/api/blueprints/cm-types");
  }

  async getCMTypeByName(name: string): Promise<ApiResponse<CMType>> {
    return this.request<CMType>(`/api/blueprints/cm-types/${encodeURIComponent(name)}`);
  }

  async createCMType(data: unknown): Promise<ApiResponse<CMType>> {
    return this.request<CMType>("/api/blueprints/cm-types", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Blueprints - Unit Types
  async getUnitTypes(): Promise<ApiResponse<UnitType[]>> {
    return this.request<UnitType[]>("/api/blueprints/unit-types");
  }

  async createUnitType(data: unknown): Promise<ApiResponse<UnitType>> {
    return this.request<UnitType>("/api/blueprints/unit-types", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Blueprints - Phase Types
  async getPhaseTypes(): Promise<ApiResponse<PhaseType[]>> {
    return this.request<PhaseType[]>("/api/blueprints/phase-types");
  }

  async createPhaseType(data: unknown): Promise<ApiResponse<PhaseType>> {
    return this.request<PhaseType>("/api/blueprints/phase-types", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Blueprints - Import
  async importBlueprints(data: unknown): Promise<
    ApiResponse<{
      success: boolean;
      imported?: {
        cmTypes: number;
        cmInstances: number;
        unitTypes: number;
        unitInstances: number;
        phaseTypes: number;
      };
      warnings?: string[];
      errors?: string[];
    }>
  > {
    return this.request("/api/blueprints/import", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Anchor Operations
  async createAnchor(data: {
    dataHash: string;
    metadata?: Record<string, unknown>;
  }): Promise<
    ApiResponse<{
      anchorId: string;
      dataHash: string;
      status: string;
      batchId?: string;
    }>
  > {
    return this.request("/api/anchor", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async batchAnchor(hashes: string[]): Promise<
    ApiResponse<{
      batchId: string;
      hashCount: number;
      status: string;
    }>
  > {
    return this.request("/api/anchor/batch", {
      method: "POST",
      body: JSON.stringify({ hashes }),
    });
  }

  async verifyAnchor(anchorId: string): Promise<
    ApiResponse<{
      anchorId: string;
      valid: boolean;
      dataHash: string;
      merkleRoot?: string;
      blockNumber?: number;
      txHash?: string;
    }>
  > {
    return this.request(`/api/anchor/${anchorId}/verify`);
  }

  async getAnchorProof(anchorId: string): Promise<
    ApiResponse<{
      anchorId: string;
      dataHash: string;
      merkleRoot: string;
      leafIndex: number;
      proof: string[];
    }>
  > {
    return this.request(`/api/anchor/${anchorId}/proof`);
  }

  async getAnchorStatus(anchorId: string): Promise<
    ApiResponse<{
      anchorId: string;
      status: string;
      dataHash: string;
      batchId?: string;
      merkleRoot?: string;
      txHash?: string;
      blockNumber?: number;
      createdAt: string;
      anchoredAt?: string;
    }>
  > {
    return this.request(`/api/anchor/${anchorId}`);
  }

  // Tree Operations
  async getTreeInfo(): Promise<
    ApiResponse<{
      root: string | null;
      leafCount: number;
      height: number;
      lastUpdated?: string;
    }>
  > {
    return this.request("/api/anchor/tree");
  }

  async getTreeRoot(): Promise<
    ApiResponse<{
      root: string | null;
    }>
  > {
    return this.request("/api/anchor/tree/root");
  }

  async getPendingAnchors(): Promise<
    ApiResponse<{
      count: number;
      events: Array<{
        id: string;
        eventType?: string;
        type?: string;
        assetId?: string;
        receivedAt?: string;
        timestamp?: string;
      }>;
    }>
  > {
    return this.request("/api/batch/pending");
  }

  async getBatchHistory(limit = 20): Promise<
    ApiResponse<
      Array<{
        batchId: string;
        eventCount: number;
        merkleRoot: string;
        txHash?: string;
        anchoredAt?: string;
      }>
    >
  > {
    return this.request(`/api/batch/history?limit=${limit}`);
  }

  // Audit Operations
  async auditAnchors(params: {
    from?: string;
    to?: string;
  }): Promise<
    ApiResponse<{
      totalAnchors: number;
      anchoredCount: number;
      pendingCount: number;
      failedCount: number;
      batchCount: number;
      avgEventsPerBatch?: number;
      issues?: string[];
    }>
  > {
    const queryParams = new URLSearchParams();
    if (params.from) queryParams.set("from", params.from);
    if (params.to) queryParams.set("to", params.to);
    const query = queryParams.toString();
    return this.request(`/api/anchor/audit${query ? `?${query}` : ""}`);
  }

  // ==========================================================================
  // AGENTS
  // ==========================================================================

  async getAgents(): Promise<ApiResponse<Agent[]>> {
    return this.request<Agent[]>("/api/agents");
  }

  async getAgentById(id: string): Promise<ApiResponse<Agent>> {
    return this.request<Agent>(`/api/agents/${id}`);
  }

  async startAgent(id: string): Promise<ApiResponse<Agent>> {
    return this.request<Agent>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ACTIVE" }),
    });
  }

  async stopAgent(id: string): Promise<ApiResponse<Agent>> {
    return this.request<Agent>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "INACTIVE" }),
    });
  }

  async getAgentLogs(id: string, limit = 100): Promise<ApiResponse<AgentLog[]>> {
    const response = await this.request<Array<{ createdAt: string; outputType: string; title: string; content: unknown }>>(
      `/api/agents/${id}/outputs`
    );
    if (!response.success || !response.data) {
      return { success: false, error: response.error };
    }
    const logs: AgentLog[] = response.data.slice(0, limit).map((output) => ({
      timestamp: output.createdAt,
      level: output.outputType === "ALERT" ? "warn" : "info",
      message: output.title || JSON.stringify(output.content),
    }));
    return { success: true, data: logs };
  }

  async getAgentConfig(id: string): Promise<ApiResponse<AgentStateEntry[]>> {
    return this.request<AgentStateEntry[]>(`/api/agents/${id}/state`);
  }

  async setAgentConfig(
    id: string,
    key: string,
    value: unknown
  ): Promise<ApiResponse<AgentStateEntry>> {
    return this.request<AgentStateEntry>(`/api/agents/${id}/state/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  }

  // ==========================================================================
  // AGENT PROPOSALS
  // ==========================================================================

  async getProposals(): Promise<ApiResponse<AgentProposal[]>> {
    return this.request<AgentProposal[]>("/api/agents/proposals");
  }

  async getAgentProposals(agentId: string): Promise<ApiResponse<AgentProposal[]>> {
    return this.request<AgentProposal[]>(`/api/agents/${agentId}/proposals`);
  }

  async getProposalById(id: string): Promise<ApiResponse<AgentProposal>> {
    const response = await this.getProposals();
    if (!response.success || !response.data) {
      return { success: false, error: response.error || "Failed to fetch proposals" };
    }
    const proposal = response.data.find((p) => p.id === id);
    if (!proposal) {
      return { success: false, error: `Proposal with ID '${id}' not found` };
    }
    return { success: true, data: proposal };
  }

  async approveProposal(
    id: string,
    approval: { userId: string; userName: string; comment?: string; signature?: string }
  ): Promise<ApiResponse<AgentProposal>> {
    return this.request<AgentProposal>(`/api/agents/proposals/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(approval),
    });
  }

  async rejectProposal(
    id: string,
    rejection: { userId: string; userName: string; comment: string; signature?: string }
  ): Promise<ApiResponse<AgentProposal>> {
    return this.request<AgentProposal>(`/api/agents/proposals/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(rejection),
    });
  }
}

// Blueprint types
export interface CMType {
  id: string;
  name: string;
  inputs: unknown[];
  outputs: unknown[];
  inOuts: unknown[];
  sourcePackage?: string;
  createdAt?: string;
}

export interface UnitType {
  id: string;
  name: string;
  description?: string;
  variables?: unknown[];
  createdAt?: string;
}

export interface PhaseType {
  id: string;
  name: string;
  description?: string;
  linkedModules?: unknown[];
  inputs?: unknown[];
  outputs?: unknown[];
  inOuts?: unknown[];
  internalValues?: unknown[];
  sequences?: Record<string, unknown>;
  createdAt?: string;
}

// Singleton instance
let apiClient: ApiClient | null = null;

export function getApiClient(config?: Partial<Config>): ApiClient {
  if (!apiClient || config) {
    apiClient = new ApiClient(config);
  }
  return apiClient;
}
