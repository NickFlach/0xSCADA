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

  // ==========================================================================
  // AGENTS (Issue #90: Governance Agent Management)
  // ==========================================================================

  // List all agents
  async getAgents(): Promise<ApiResponse<Agent[]>> {
    return this.request<Agent[]>("/api/agents");
  }

  // Get agent by ID
  async getAgentById(id: string): Promise<ApiResponse<Agent>> {
    return this.request<Agent>(`/api/agents/${id}`);
  }

  // Get agent state
  async getAgentState(agentId: string): Promise<ApiResponse<AgentState[]>> {
    return this.request<AgentState[]>(`/api/agents/${agentId}/state`);
  }

  // Get agent outputs
  async getAgentOutputs(agentId: string): Promise<ApiResponse<AgentOutput[]>> {
    return this.request<AgentOutput[]>(`/api/agents/${agentId}/outputs`);
  }

  // Get agent logs (audit entries)
  async getAgentLogs(agentId: string, limit = 100): Promise<ApiResponse<AgentAuditEntry[]>> {
    return this.request<AgentAuditEntry[]>(`/api/agents/${agentId}/logs?limit=${limit}`);
  }

  // Start agent
  async startAgent(agentId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request<{ success: boolean }>(`/api/agents/${agentId}/start`, {
      method: "POST",
    });
  }

  // Stop agent
  async stopAgent(agentId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request<{ success: boolean }>(`/api/agents/${agentId}/stop`, {
      method: "POST",
    });
  }

  // Set agent configuration value
  async setAgentConfig(
    agentId: string,
    key: string,
    value: string
  ): Promise<ApiResponse<{ success: boolean }>> {
    return this.request<{ success: boolean }>(`/api/agents/${agentId}/state/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  }

  // ==========================================================================
  // AGENT PROPOSALS
  // ==========================================================================

  // List all proposals
  async getProposals(): Promise<ApiResponse<AgentProposal[]>> {
    return this.request<AgentProposal[]>("/api/agents/proposals");
  }

  // Get proposal by ID
  async getProposalById(id: string): Promise<ApiResponse<AgentProposal>> {
    // Try to find in list first (API doesn't have direct get by ID)
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

  // Approve proposal
  async approveProposal(
    proposalId: string,
    approval: {
      userId: string;
      userName: string;
      comment?: string;
    }
  ): Promise<ApiResponse<AgentProposal>> {
    return this.request<AgentProposal>(`/api/agents/proposals/${proposalId}/approve`, {
      method: "POST",
      body: JSON.stringify({
        ...approval,
        signature: `cli-signature-${Date.now()}`, // CLI generates a simple signature
      }),
    });
  }

  // Reject proposal
  async rejectProposal(
    proposalId: string,
    rejection: {
      userId: string;
      userName: string;
      comment: string;
    }
  ): Promise<ApiResponse<AgentProposal>> {
    return this.request<AgentProposal>(`/api/agents/proposals/${proposalId}/reject`, {
      method: "POST",
      body: JSON.stringify({
        ...rejection,
        signature: `cli-signature-${Date.now()}`, // CLI generates a simple signature
      }),
    });
  }
}

// =============================================================================
// AGENT TYPES (for CLI)
// =============================================================================

export interface Agent {
  id: string;
  name: string;
  displayName: string;
  agentType: string;
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED" | "ERROR";
  capabilities: string[];
  scope: {
    allSites?: boolean;
    siteIds?: string[];
    allAssets?: boolean;
    assetIds?: string[];
    assetTypes?: string[];
    allEventTypes?: boolean;
    eventTypes?: string[];
    maxHistoryDays?: number;
  };
  publicKey: string;
  version?: string;
  createdAt: string;
  updatedAt?: string;
  lastActiveAt?: string;
  errorCount?: number;
  lastError?: string;
}

export interface AgentProposal {
  id: string;
  agentId: string;
  proposalType: string;
  title: string;
  description: string;
  action: unknown;
  reasoning: string;
  confidence: number;
  supportingEventIds: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskFactors: string[];
  hash: string;
  signature: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXPIRED" | "EXECUTED" | "FAILED";
  requiredApprovals: number;
  approvals: Array<{
    userId: string;
    userName: string;
    decision: "APPROVE" | "REJECT";
    comment?: string;
    signature: string;
    decidedAt: string;
  }>;
  createdAt: string;
  expiresAt?: string;
  executedAt?: string;
  executionResult?: unknown;
  executionError?: string;
}

export interface AgentOutput {
  id: string;
  agentId: string;
  outputType: string;
  title: string;
  content: unknown;
  siteId?: string;
  assetIds?: string[];
  eventIds?: string[];
  hash: string;
  signature: string;
  confidence?: number;
  reasoning?: string;
  createdAt: string;
}

export interface AgentState {
  key: string;
  value: unknown;
  updatedAt?: string;
  expiresAt?: string;
}

export interface AgentAuditEntry {
  id: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
  signature?: string;
}

// Singleton instance
let apiClient: ApiClient | null = null;

export function getApiClient(config?: Partial<Config>): ApiClient {
  if (!apiClient || config) {
    apiClient = new ApiClient(config);
  }
  return apiClient;
}
