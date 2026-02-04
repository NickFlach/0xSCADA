/**
 * Hardware Security Module (HSM) Integration
 *
 * Comprehensive HSM integration for secure key management in critical
 * infrastructure. Provides:
 * - PKCS#11 interface for HSM communication
 * - Key generation, storage, and retrieval operations
 * - Digital signing and verification using HSM keys
 * - Key rotation and lifecycle management
 * - Fallback to software keys for development
 * - Audit logging of all key operations
 */

import { PKCS11Interface } from "./pkcs11-interface";
import { HSMKeyManager } from "./key-manager";
import { HSMCryptoOperations } from "./crypto-operations";
import { HSMAuditLogger, InMemoryAuditStorage, createAuditLogger } from "./audit-logger";
import {
  type HSMConfig,
  type HSMConnectionStatus,
  type HSMKeyMetadata,
  type HSMKeyPair,
  type HSMKeyGenerationRequest,
  type HSMKeyRotationRequest,
  type HSMKeyRotationResult,
  type HSMSignature,
  type HSMVerificationResult,
  type HSMEncryptionResult,
  type HSMDecryptionResult,
  type HSMAuditLogEntry,
  type HSMKeyAlgorithm,
  type HSMKeyState,
  type HSMProviderType,
  HSMError,
  HSMErrorCode,
} from "./types";

// =============================================================================
// HSM SERVICE
// =============================================================================

/**
 * Main HSM service providing a unified interface for all HSM operations
 */
export class HSMService {
  private config: HSMConfig;
  private keyManager: HSMKeyManager;
  private cryptoOps: HSMCryptoOperations;
  private auditLogger: HSMAuditLogger;
  private initialized: boolean = false;

  constructor(config: HSMConfig) {
    this.config = config;
    this.keyManager = new HSMKeyManager(config);
    this.cryptoOps = new HSMCryptoOperations(this.keyManager);
    this.auditLogger = createAuditLogger(config);
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the HSM service
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.keyManager.initialize();
      await this.cryptoOps.initialize();
      this.initialized = true;

      await this.auditLogger.logSessionOperation(
        "LOGIN",
        "system",
        "SUCCESS",
        undefined,
        { provider: this.config.provider }
      );
    } catch (error) {
      await this.auditLogger.logSessionOperation(
        "LOGIN",
        "system",
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Shutdown the HSM service
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    await this.auditLogger.logSessionOperation("LOGOUT", "system", "SUCCESS");
    await this.keyManager.shutdown();
    this.initialized = false;
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): HSMConnectionStatus {
    return this.keyManager.getPKCS11Interface().getConnectionStatus();
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ===========================================================================
  // KEY MANAGEMENT
  // ===========================================================================

  /**
   * Generate a new asymmetric key pair
   */
  async generateKeyPair(
    request: HSMKeyGenerationRequest,
    actorId: string = "system"
  ): Promise<HSMKeyPair> {
    this.ensureInitialized();
    this.keyManager.setActorId(actorId);

    try {
      const keyPair = await this.keyManager.generateKeyPair(request);

      await this.auditLogger.logKeyOperation(
        "KEY_GENERATE",
        keyPair.metadata.id,
        keyPair.metadata.label,
        actorId,
        "SUCCESS",
        undefined,
        {
          algorithm: request.algorithm,
          keyType: "asymmetric",
        }
      );

      return keyPair;
    } catch (error) {
      await this.auditLogger.logKeyOperation(
        "KEY_GENERATE",
        "",
        request.label,
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Generate a new symmetric key
   */
  async generateSymmetricKey(
    request: HSMKeyGenerationRequest,
    actorId: string = "system"
  ): Promise<HSMKeyMetadata> {
    this.ensureInitialized();
    this.keyManager.setActorId(actorId);

    try {
      const metadata = await this.keyManager.generateSymmetricKey(request);

      await this.auditLogger.logKeyOperation(
        "KEY_GENERATE",
        metadata.id,
        metadata.label,
        actorId,
        "SUCCESS",
        undefined,
        {
          algorithm: request.algorithm,
          keyType: "symmetric",
        }
      );

      return metadata;
    } catch (error) {
      await this.auditLogger.logKeyOperation(
        "KEY_GENERATE",
        "",
        request.label,
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Get key metadata by ID
   */
  getKeyMetadata(keyId: string): HSMKeyMetadata | undefined {
    return this.keyManager.getKeyMetadata(keyId);
  }

  /**
   * Get key by label
   */
  getKeyByLabel(label: string): HSMKeyMetadata | undefined {
    return this.keyManager.getKeyByLabel(label);
  }

  /**
   * List all keys
   */
  listKeys(filter?: {
    state?: HSMKeyState;
    algorithm?: HSMKeyAlgorithm;
  }): HSMKeyMetadata[] {
    return this.keyManager.listKeys(filter);
  }

  /**
   * Rotate a key
   */
  async rotateKey(
    request: HSMKeyRotationRequest,
    actorId: string = "system"
  ): Promise<HSMKeyRotationResult> {
    this.ensureInitialized();
    this.keyManager.setActorId(actorId);

    try {
      const result = await this.keyManager.rotateKey(request);

      await this.auditLogger.logKeyOperation(
        "KEY_ROTATE",
        result.newKey.id,
        result.newKey.label,
        actorId,
        "SUCCESS",
        undefined,
        {
          oldKeyId: request.oldKeyId,
          oldKeyStatus: result.oldKeyStatus,
        }
      );

      return result;
    } catch (error) {
      await this.auditLogger.logKeyOperation(
        "KEY_ROTATE",
        request.oldKeyId,
        "",
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Deactivate a key
   */
  async deactivateKey(
    keyId: string,
    reason: string,
    actorId: string = "system"
  ): Promise<void> {
    this.ensureInitialized();
    this.keyManager.setActorId(actorId);

    const metadata = this.keyManager.getKeyMetadata(keyId);

    try {
      await this.keyManager.deactivateKey(keyId, reason);

      await this.auditLogger.logKeyOperation(
        "KEY_DEACTIVATE",
        keyId,
        metadata?.label || "",
        actorId,
        "SUCCESS",
        undefined,
        { reason }
      );
    } catch (error) {
      await this.auditLogger.logKeyOperation(
        "KEY_DEACTIVATE",
        keyId,
        metadata?.label || "",
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Destroy a key
   */
  async destroyKey(
    keyId: string,
    reason: string,
    actorId: string = "system"
  ): Promise<void> {
    this.ensureInitialized();
    this.keyManager.setActorId(actorId);

    const metadata = this.keyManager.getKeyMetadata(keyId);

    try {
      await this.keyManager.destroyKey(keyId, reason);

      await this.auditLogger.logKeyOperation(
        "KEY_DESTROY",
        keyId,
        metadata?.label || "",
        actorId,
        "SUCCESS",
        undefined,
        { reason }
      );
    } catch (error) {
      await this.auditLogger.logKeyOperation(
        "KEY_DESTROY",
        keyId,
        metadata?.label || "",
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  /**
   * Get key state
   */
  getKeyState(keyId: string): HSMKeyState | undefined {
    return this.keyManager.getKeyState(keyId);
  }

  /**
   * Check if key is expired
   */
  isKeyExpired(keyId: string): boolean {
    return this.keyManager.isKeyExpired(keyId);
  }

  /**
   * Get expired keys
   */
  getExpiredKeys(): HSMKeyMetadata[] {
    return this.keyManager.getExpiredKeys();
  }

  // ===========================================================================
  // CRYPTOGRAPHIC OPERATIONS
  // ===========================================================================

  /**
   * Sign data
   */
  async sign(
    keyId: string,
    data: Buffer | string,
    actorId: string = "system"
  ): Promise<HSMSignature> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);

    try {
      const signature = await this.cryptoOps.sign(keyId, data);

      await this.auditLogger.logCryptoOperation(
        "SIGN",
        keyId,
        actorId,
        "SUCCESS",
        undefined,
        {
          keyLabel: metadata?.label,
          dataSize: typeof data === "string" ? data.length : data.length,
        }
      );

      return signature;
    } catch (error) {
      await this.auditLogger.logCryptoOperation(
        "SIGN",
        keyId,
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error",
        { keyLabel: metadata?.label }
      );
      throw error;
    }
  }

  /**
   * Verify a signature
   */
  async verify(
    keyId: string,
    data: Buffer | string,
    signature: Buffer | HSMSignature,
    actorId: string = "system"
  ): Promise<HSMVerificationResult> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);

    const result = await this.cryptoOps.verify(keyId, data, signature);

    await this.auditLogger.logCryptoOperation(
      "VERIFY",
      keyId,
      actorId,
      result.valid ? "SUCCESS" : "FAILURE",
      result.error,
      {
        keyLabel: metadata?.label,
        valid: result.valid,
      }
    );

    return result;
  }

  /**
   * Encrypt data
   */
  async encrypt(
    keyId: string,
    plaintext: Buffer | string,
    actorId: string = "system"
  ): Promise<HSMEncryptionResult> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);

    try {
      const result = await this.cryptoOps.encrypt(keyId, plaintext);

      await this.auditLogger.logCryptoOperation(
        "ENCRYPT",
        keyId,
        actorId,
        "SUCCESS",
        undefined,
        {
          keyLabel: metadata?.label,
          plaintextSize: typeof plaintext === "string" ? plaintext.length : plaintext.length,
        }
      );

      return result;
    } catch (error) {
      await this.auditLogger.logCryptoOperation(
        "ENCRYPT",
        keyId,
        actorId,
        "FAILURE",
        error instanceof Error ? error.message : "Unknown error",
        { keyLabel: metadata?.label }
      );
      throw error;
    }
  }

  /**
   * Decrypt data
   */
  async decrypt(
    keyId: string,
    ciphertext: Buffer,
    iv: Buffer,
    actorId: string = "system"
  ): Promise<HSMDecryptionResult> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);

    const result = await this.cryptoOps.decrypt(keyId, ciphertext, iv);

    await this.auditLogger.logCryptoOperation(
      "DECRYPT",
      keyId,
      actorId,
      result.success ? "SUCCESS" : "FAILURE",
      result.error,
      { keyLabel: metadata?.label }
    );

    return result;
  }

  /**
   * Hash data using HSM
   */
  async hash(data: Buffer | string): Promise<Buffer> {
    return this.cryptoOps.hash(data);
  }

  /**
   * Hash data and return hex string
   */
  async hashHex(data: Buffer | string): Promise<string> {
    return this.cryptoOps.hashHex(data);
  }

  // ===========================================================================
  // AUDIT LOGGING
  // ===========================================================================

  /**
   * Get audit log entries
   */
  async getAuditLog(filter?: {
    keyId?: string;
    actorId?: string;
    operation?: string;
    result?: "SUCCESS" | "FAILURE";
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): Promise<HSMAuditLogEntry[]> {
    return this.auditLogger.query(filter);
  }

  /**
   * Get audit log statistics
   */
  async getAuditStatistics(): Promise<{
    totalEntries: number;
    byOperation: Record<string, number>;
    byResult: Record<string, number>;
    recentFailures: number;
    integrityValid: boolean;
  }> {
    return this.auditLogger.getStatistics();
  }

  /**
   * Verify audit log integrity
   */
  async verifyAuditIntegrity(): Promise<{
    valid: boolean;
    totalEntries: number;
    checkedEntries: number;
    error?: string;
  }> {
    return this.auditLogger.verifyIntegrity();
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new HSMError(
        HSMErrorCode.NOT_INITIALIZED,
        "HSM service not initialized. Call initialize() first."
      );
    }
  }
}

// =============================================================================
// SINGLETON MANAGEMENT
// =============================================================================

let hsmServiceInstance: HSMService | null = null;

/**
 * Get the HSM service singleton
 */
export function getHSMService(): HSMService {
  if (!hsmServiceInstance) {
    const config: HSMConfig = {
      provider: (process.env.HSM_PROVIDER as HSMProviderType) || "SOFTWARE",
      libraryPath: process.env.HSM_LIBRARY_PATH,
      slotId: process.env.HSM_SLOT_ID ? parseInt(process.env.HSM_SLOT_ID) : 0,
      pin: process.env.HSM_PIN,
      enableSoftwareFallback: process.env.HSM_SOFTWARE_FALLBACK !== "false",
      sessionPoolSize: process.env.HSM_SESSION_POOL_SIZE
        ? parseInt(process.env.HSM_SESSION_POOL_SIZE)
        : 10,
      auditEnabled: process.env.HSM_AUDIT_ENABLED !== "false",
    };

    hsmServiceInstance = new HSMService(config);
  }

  return hsmServiceInstance;
}

/**
 * Initialize the HSM service with custom configuration
 */
export function initHSMService(config: HSMConfig): HSMService {
  hsmServiceInstance = new HSMService(config);
  return hsmServiceInstance;
}

/**
 * Reset the HSM service singleton (for testing)
 */
export async function resetHSMService(): Promise<void> {
  if (hsmServiceInstance) {
    await hsmServiceInstance.shutdown();
    hsmServiceInstance = null;
  }
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

export {
  PKCS11Interface,
  HSMKeyManager,
  HSMCryptoOperations,
  HSMAuditLogger,
  InMemoryAuditStorage,
  createAuditLogger,
};

export * from "./types";
