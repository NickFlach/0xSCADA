/**
 * Agent Marketplace & Plugin System Types
 * ADR-0013 [13.6]
 */

export type PluginStatus = 'available' | 'installing' | 'installed' | 'running' | 'stopped' | 'error' | 'deprecated';
export type PluginCategory = 'intelligence' | 'integration' | 'reporting' | 'safety' | 'optimization' | 'custom';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: PluginCategory;
  requiredCapabilities: string[];
  entryPoint: string;
  configSchema: Record<string, PluginConfigField>;
  dependencies: Record<string, string>; // pluginId -> semver
  minPlatformVersion: string;
  tags: string[];
}

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  description: string;
  default?: unknown;
  required: boolean;
  options?: string[]; // for select type
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  installedAt: number;
  config: Record<string, unknown>;
  lastHealthCheck: number;
  errorCount: number;
  lastError?: string;
}

export interface PluginExecutionContext {
  pluginId: string;
  capabilities: string[];
  sandbox: {
    allowNetwork: boolean;
    allowFileSystem: boolean;
    memoryLimitMb: number;
    timeoutMs: number;
  };
}

export interface PluginHealthStatus {
  pluginId: string;
  healthy: boolean;
  uptime: number;
  memoryUsageMb: number;
  lastActivity: number;
  errorRate: number;
}

export interface MarketplaceEntry {
  manifest: PluginManifest;
  downloads: number;
  rating: number;
  verified: boolean;
  publishedAt: number;
  updatedAt: number;
}
