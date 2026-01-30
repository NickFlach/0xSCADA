/**
 * Ubiquity Service - Main Export
 * Central module for Rockwell FactoryTalk Optix Ubiquity SDK integration
 */

// Types
export * from "./ubiquity-types";

// Bridge Client
export {
  UbiquityBridgeClient,
  getUbiquityClient,
  initializeUbiquityClient,
} from "./ubiquity-client";

// Credentials Manager
export {
  CredentialsManager,
  getCredentialsManager,
  type UbiquityCredentialInput,
  type DecryptedCredentials,
} from "./credentials-manager";

// Device Manager
export {
  DeviceManager,
  getDeviceManager,
} from "./device-manager";

// =============================================================================
// SERVICE INITIALIZATION
// =============================================================================

import { initializeUbiquityClient } from "./ubiquity-client";
import type { UbiquityServiceConfig } from "./ubiquity-types";

let initialized = false;

/**
 * Initialize the Ubiquity service
 * Must be called before using any Ubiquity functionality
 */
export function initializeUbiquityService(config?: Partial<UbiquityServiceConfig>): void {
  if (initialized) {
    console.warn("Ubiquity service already initialized");
    return;
  }

  const bridgeUrl = config?.bridgeBaseUrl ?? process.env.UBIQUITY_BRIDGE_URL ?? "http://localhost:8080";

  initializeUbiquityClient({
    bridgeBaseUrl: bridgeUrl,
    timeout: config?.timeout ?? 30000,
    retryAttempts: config?.retryAttempts ?? 3,
    retryDelay: config?.retryDelay ?? 1000,
  });

  initialized = true;
  console.log(`✅ Ubiquity service initialized with bridge at ${bridgeUrl}`);
}

/**
 * Check if Ubiquity service is initialized
 */
export function isUbiquityServiceInitialized(): boolean {
  return initialized;
}
