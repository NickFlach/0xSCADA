/**
 * Ubiquity Bridge Client
 * HTTP client for communicating with the .NET Ubiquity Bridge microservice
 */

import type {
  UbiquityServiceConfig,
  UbiquityBridgeHealthStatus,
  UbiquityDomainConfig,
  UbiquityDomain,
  ConnectDomainResponse,
  UbiquityDevice,
  DeviceDiscoveryResult,
  DeviceStatus,
  FileTransferRequest,
  FileTransfer,
  FirmwareDeploymentRequest,
  FirmwareDeployment,
  RemoteFile,
  StartSessionRequest,
  RemoteSession,
  InputEvent,
  SystemMetrics,
  ProcessInfo,
  ProcessActionRequest,
  ProcessActionResult,
  ProcessSnapshot,
} from "./ubiquity-types";

export class UbiquityBridgeClient {
  private baseUrl: string;
  private timeout: number;
  private retryAttempts: number;
  private retryDelay: number;

  constructor(config: UbiquityServiceConfig) {
    this.baseUrl = config.bridgeBaseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? 30000;
    this.retryAttempts = config.retryAttempts ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  // ===========================================================================
  // HEALTH CHECK
  // ===========================================================================

  async checkHealth(): Promise<UbiquityBridgeHealthStatus> {
    try {
      const response = await this.request<{ status: string }>("GET", "/health");
      return {
        healthy: response.status === "Healthy",
        status: response.status,
      };
    } catch (error) {
      return {
        healthy: false,
        status: "Unreachable",
      };
    }
  }

  // ===========================================================================
  // DOMAIN OPERATIONS
  // ===========================================================================

  async connectDomain(config: UbiquityDomainConfig): Promise<ConnectDomainResponse> {
    return this.request<ConnectDomainResponse>("POST", "/api/domains/connect", {
      cloudEndpoint: config.cloudEndpoint,
      username: config.username,
      password: config.password,
      apiKey: config.apiKey,
      tenantId: config.tenantId,
    });
  }

  async disconnectDomain(domainId: string): Promise<void> {
    await this.request("POST", `/api/domains/${domainId}/disconnect`);
  }

  async getDomainStatus(domainId: string): Promise<UbiquityDomain | null> {
    try {
      return await this.request<UbiquityDomain>("GET", `/api/domains/${domainId}/status`);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async listDomains(): Promise<UbiquityDomain[]> {
    return this.request<UbiquityDomain[]>("GET", "/api/domains");
  }

  // ===========================================================================
  // DEVICE OPERATIONS
  // ===========================================================================

  async discoverDevices(domainId: string): Promise<DeviceDiscoveryResult> {
    return this.request<DeviceDiscoveryResult>("POST", `/api/devices/discover/${domainId}`);
  }

  async listDevices(domainId?: string): Promise<UbiquityDevice[]> {
    const query = domainId ? `?domainId=${domainId}` : "";
    return this.request<UbiquityDevice[]>("GET", `/api/devices${query}`);
  }

  async getDevice(deviceId: string): Promise<UbiquityDevice | null> {
    try {
      return await this.request<UbiquityDevice>("GET", `/api/devices/${deviceId}`);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
    try {
      return await this.request<DeviceStatus>("GET", `/api/devices/${deviceId}/status`);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async updateDevice(deviceId: string, updates: Record<string, unknown>): Promise<UbiquityDevice | null> {
    try {
      return await this.request<UbiquityDevice>("PUT", `/api/devices/${deviceId}`, updates);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/api/devices/${deviceId}`);
      return true;
    } catch (error: any) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  // ===========================================================================
  // FILE TRANSFER OPERATIONS
  // ===========================================================================

  async uploadFile(request: FileTransferRequest): Promise<FileTransfer> {
    return this.request<FileTransfer>("POST", "/api/files/upload", request);
  }

  async downloadFile(request: FileTransferRequest): Promise<FileTransfer> {
    return this.request<FileTransfer>("POST", "/api/files/download", request);
  }

  async listTransfers(deviceId?: string): Promise<FileTransfer[]> {
    const query = deviceId ? `?deviceId=${deviceId}` : "";
    return this.request<FileTransfer[]>("GET", `/api/files/transfers${query}`);
  }

  async getTransfer(transferId: string): Promise<FileTransfer | null> {
    try {
      return await this.request<FileTransfer>("GET", `/api/files/transfers/${transferId}`);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async cancelTransfer(transferId: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/api/files/transfers/${transferId}`);
      return true;
    } catch (error: any) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async deployFirmware(request: FirmwareDeploymentRequest): Promise<FirmwareDeployment> {
    return this.request<FirmwareDeployment>("POST", "/api/files/firmware", request);
  }

  async listDirectory(deviceId: string, path: string, recursive = false): Promise<RemoteFile[]> {
    return this.request<RemoteFile[]>("POST", "/api/files/list", {
      deviceId,
      path,
      recursive,
    });
  }

  // ===========================================================================
  // SESSION OPERATIONS
  // ===========================================================================

  async startSession(request: StartSessionRequest): Promise<RemoteSession> {
    return this.request<RemoteSession>("POST", "/api/sessions/start", request);
  }

  async listActiveSessions(deviceId?: string): Promise<RemoteSession[]> {
    const query = deviceId ? `?deviceId=${deviceId}` : "";
    return this.request<RemoteSession[]>("GET", `/api/sessions${query}`);
  }

  async getSession(sessionId: string): Promise<RemoteSession | null> {
    try {
      return await this.request<RemoteSession>("GET", `/api/sessions/${sessionId}`);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async endSession(sessionId: string, reason?: string): Promise<void> {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    await this.request("DELETE", `/api/sessions/${sessionId}${query}`);
  }

  async sendInput(sessionId: string, event: Omit<InputEvent, "sessionId">): Promise<void> {
    await this.request("POST", `/api/sessions/${sessionId}/input`, event);
  }

  async getStreamUrl(sessionId: string): Promise<string | null> {
    try {
      const response = await this.request<{ streamUrl: string }>("GET", `/api/sessions/${sessionId}/stream`);
      return response.streamUrl;
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async getSessionHistory(deviceId: string, limit = 50): Promise<RemoteSession[]> {
    return this.request<RemoteSession[]>("GET", `/api/sessions/history/${deviceId}?limit=${limit}`);
  }

  // ===========================================================================
  // PROCESS MONITORING OPERATIONS
  // ===========================================================================

  async getSystemMetrics(deviceId: string): Promise<SystemMetrics> {
    return this.request<SystemMetrics>("GET", `/api/processes/${deviceId}/metrics`);
  }

  async getProcessList(deviceId: string): Promise<ProcessInfo[]> {
    return this.request<ProcessInfo[]>("GET", `/api/processes/${deviceId}`);
  }

  async startProcess(request: ProcessActionRequest): Promise<ProcessActionResult> {
    return this.request<ProcessActionResult>("POST", "/api/processes/start", request);
  }

  async stopProcess(request: ProcessActionRequest): Promise<ProcessActionResult> {
    return this.request<ProcessActionResult>("POST", "/api/processes/stop", request);
  }

  async restartProcess(request: ProcessActionRequest): Promise<ProcessActionResult> {
    return this.request<ProcessActionResult>("POST", "/api/processes/restart", request);
  }

  async captureSnapshot(deviceId: string): Promise<ProcessSnapshot> {
    return this.request<ProcessSnapshot>("POST", `/api/processes/${deviceId}/snapshot`);
  }

  async getLatestSnapshot(deviceId: string): Promise<ProcessSnapshot | null> {
    try {
      return await this.request<ProcessSnapshot>("GET", `/api/processes/${deviceId}/snapshot/latest`);
    } catch (error: any) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  // ===========================================================================
  // HTTP REQUEST HELPER
  // ===========================================================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 1
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error: any = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        try {
          error.details = await response.json();
        } catch {
          // Ignore JSON parse errors
        }
        throw error;
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) return {} as T;

      return JSON.parse(text) as T;
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Retry on network errors or 5xx responses
      if (
        attempt < this.retryAttempts &&
        (error.name === "AbortError" ||
          error.message?.includes("fetch") ||
          (error.status && error.status >= 500))
      ) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay * attempt));
        return this.request<T>(method, path, body, attempt + 1);
      }

      throw error;
    }
  }
}

// Singleton instance factory
let clientInstance: UbiquityBridgeClient | null = null;

export function getUbiquityClient(config?: UbiquityServiceConfig): UbiquityBridgeClient {
  if (!clientInstance && config) {
    clientInstance = new UbiquityBridgeClient(config);
  }
  if (!clientInstance) {
    throw new Error("UbiquityBridgeClient not initialized. Call getUbiquityClient with config first.");
  }
  return clientInstance;
}

export function initializeUbiquityClient(config: UbiquityServiceConfig): UbiquityBridgeClient {
  clientInstance = new UbiquityBridgeClient(config);
  return clientInstance;
}
