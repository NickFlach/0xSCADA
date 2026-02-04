/**
 * HSM Key Manager
 *
 * Provides high-level key management operations including key generation,
 * storage, retrieval, rotation, and lifecycle management using the PKCS#11
 * interface.
 */

import { randomBytes, createHash } from "crypto";
import { PKCS11Interface } from "./pkcs11-interface";
import {
  type HSMConfig,
  type HSMKeyId,
  type HSMKeyMetadata,
  type HSMKeyAlgorithm,
  type HSMKeyUsage,
  type HSMKeyPair,
  type HSMKeyGenerationRequest,
  type HSMKeyRotationRequest,
  type HSMKeyRotationResult,
  type HSMKeyState,
  type HSMKeyLifecycleEvent,
  type PKCS11MechanismType,
  type PKCS11KeyType,
  HSMError,
  HSMErrorCode,
} from "./types";

// =============================================================================
// KEY REGISTRY
// =============================================================================

interface KeyRegistryEntry {
  metadata: HSMKeyMetadata;
  publicKeyHandle?: number;
  privateKeyHandle?: number;
  secretKeyHandle?: number;
  state: HSMKeyState;
  rotatedFrom?: string;
  rotatedTo?: string;
  lifecycleEvents: HSMKeyLifecycleEvent[];
}

// =============================================================================
// KEY MANAGER
// =============================================================================

/**
 * HSM Key Manager for comprehensive key management
 */
export class HSMKeyManager {
  private pkcs11: PKCS11Interface;
  private config: HSMConfig;
  private keyRegistry: Map<string, KeyRegistryEntry> = new Map();
  private initialized: boolean = false;
  private actorId: string = "system";

  constructor(config: HSMConfig) {
    this.config = config;
    this.pkcs11 = new PKCS11Interface(config);
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the key manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.pkcs11.initialize();
    await this.pkcs11.login(this.config.pin || "default-pin");
    this.initialized = true;
  }

  /**
   * Shutdown the key manager
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    await this.pkcs11.finalize();
    this.initialized = false;
  }

  /**
   * Set the actor ID for audit logging
   */
  setActorId(actorId: string): void {
    this.actorId = actorId;
  }

  // ===========================================================================
  // KEY GENERATION
  // ===========================================================================

  /**
   * Generate a new key pair
   */
  async generateKeyPair(request: HSMKeyGenerationRequest): Promise<HSMKeyPair> {
    this.ensureInitialized();

    const keyId = this.generateKeyId();
    const label = request.label;

    // Check if key with same label exists
    for (const entry of this.keyRegistry.values()) {
      if (entry.metadata.label === label && entry.state === "ACTIVE") {
        throw new HSMError(
          HSMErrorCode.KEY_ALREADY_EXISTS,
          `Key with label '${label}' already exists`
        );
      }
    }

    // Determine PKCS#11 mechanism and key type
    const { mechanism, keyType, keySize } = this.algorithmToPKCS11(request.algorithm);

    // Generate key pair via PKCS#11
    const { publicKeyHandle, privateKeyHandle } = await this.pkcs11.generateKeyPair(
      mechanism,
      {
        objectClass: "PUBLIC_KEY",
        keyType,
        label: `${label}-pub`,
        token: true,
        encrypt: request.usage?.encrypt ?? false,
        verify: request.usage?.verify ?? true,
        wrap: request.usage?.wrap ?? false,
      },
      {
        objectClass: "PRIVATE_KEY",
        keyType,
        label,
        token: true,
        private: true,
        sensitive: true,
        extractable: request.extractable ?? false,
        sign: request.usage?.sign ?? true,
        decrypt: request.usage?.decrypt ?? false,
        unwrap: request.usage?.unwrap ?? false,
        derive: request.usage?.derive ?? false,
      }
    );

    // Create key metadata
    const now = new Date();
    const metadata: HSMKeyMetadata = {
      id: keyId,
      label,
      keyType,
      algorithm: request.algorithm,
      keySize,
      objectClass: "PRIVATE_KEY",
      createdAt: now,
      expiresAt: request.expiresInDays
        ? new Date(now.getTime() + request.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined,
      usage: {
        sign: request.usage?.sign ?? true,
        verify: request.usage?.verify ?? true,
        encrypt: request.usage?.encrypt ?? false,
        decrypt: request.usage?.decrypt ?? false,
        wrap: request.usage?.wrap ?? false,
        unwrap: request.usage?.unwrap ?? false,
        derive: request.usage?.derive ?? false,
      },
      extractable: request.extractable ?? false,
      persistent: true,
      source: this.config.provider === "SOFTWARE" ? "SOFTWARE" : "HSM",
      attributes: request.attributes,
    };

    // Generate simulated public key for export
    const publicKeyDer = randomBytes(65); // Simulated DER encoding
    publicKeyDer[0] = 0x04; // Uncompressed point indicator
    const publicKeyPem = this.derToPem(publicKeyDer, "PUBLIC KEY");

    // Register key
    const lifecycleEvent: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId,
      eventType: "CREATED",
      newState: "ACTIVE",
      timestamp: now,
      actorId: this.actorId,
    };

    this.keyRegistry.set(keyId, {
      metadata,
      publicKeyHandle,
      privateKeyHandle,
      state: "ACTIVE",
      lifecycleEvents: [lifecycleEvent],
    });

    return {
      publicKey: {
        der: publicKeyDer,
        pem: publicKeyPem,
        keyId: {
          id: keyId,
          label: `${label}-pub`,
          handle: publicKeyHandle,
        },
      },
      privateKeyId: {
        id: keyId,
        label,
        handle: privateKeyHandle,
      },
      metadata,
    };
  }

  /**
   * Generate a symmetric key
   */
  async generateSymmetricKey(request: HSMKeyGenerationRequest): Promise<HSMKeyMetadata> {
    this.ensureInitialized();

    const keyId = this.generateKeyId();
    const label = request.label;

    // Check if key with same label exists
    for (const entry of this.keyRegistry.values()) {
      if (entry.metadata.label === label && entry.state === "ACTIVE") {
        throw new HSMError(
          HSMErrorCode.KEY_ALREADY_EXISTS,
          `Key with label '${label}' already exists`
        );
      }
    }

    // Determine PKCS#11 mechanism
    const { mechanism, keyType, keySize } = this.algorithmToPKCS11(request.algorithm);

    // Generate secret key via PKCS#11
    const secretKeyHandle = await this.pkcs11.generateSecretKey(mechanism, {
      objectClass: "SECRET_KEY",
      keyType,
      label,
      valueLen: keySize / 8,
      token: true,
      private: true,
      sensitive: true,
      extractable: request.extractable ?? false,
      encrypt: request.usage?.encrypt ?? true,
      decrypt: request.usage?.decrypt ?? true,
      sign: request.usage?.sign ?? false,
      verify: request.usage?.verify ?? false,
      wrap: request.usage?.wrap ?? false,
      unwrap: request.usage?.unwrap ?? false,
    });

    // Create key metadata
    const now = new Date();
    const metadata: HSMKeyMetadata = {
      id: keyId,
      label,
      keyType,
      algorithm: request.algorithm,
      keySize,
      objectClass: "SECRET_KEY",
      createdAt: now,
      expiresAt: request.expiresInDays
        ? new Date(now.getTime() + request.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined,
      usage: {
        sign: request.usage?.sign ?? false,
        verify: request.usage?.verify ?? false,
        encrypt: request.usage?.encrypt ?? true,
        decrypt: request.usage?.decrypt ?? true,
        wrap: request.usage?.wrap ?? false,
        unwrap: request.usage?.unwrap ?? false,
        derive: request.usage?.derive ?? false,
      },
      extractable: request.extractable ?? false,
      persistent: true,
      source: this.config.provider === "SOFTWARE" ? "SOFTWARE" : "HSM",
      attributes: request.attributes,
    };

    // Register key
    const lifecycleEvent: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId,
      eventType: "CREATED",
      newState: "ACTIVE",
      timestamp: now,
      actorId: this.actorId,
    };

    this.keyRegistry.set(keyId, {
      metadata,
      secretKeyHandle,
      state: "ACTIVE",
      lifecycleEvents: [lifecycleEvent],
    });

    return metadata;
  }

  // ===========================================================================
  // KEY RETRIEVAL
  // ===========================================================================

  /**
   * Get key metadata by ID
   */
  getKeyMetadata(keyId: string): HSMKeyMetadata | undefined {
    const entry = this.keyRegistry.get(keyId);
    return entry?.metadata;
  }

  /**
   * Get key by label
   */
  getKeyByLabel(label: string): HSMKeyMetadata | undefined {
    for (const entry of this.keyRegistry.values()) {
      if (entry.metadata.label === label && entry.state === "ACTIVE") {
        return entry.metadata;
      }
    }
    return undefined;
  }

  /**
   * List all keys
   */
  listKeys(filter?: {
    state?: HSMKeyState;
    algorithm?: HSMKeyAlgorithm;
    objectClass?: "PUBLIC_KEY" | "PRIVATE_KEY" | "SECRET_KEY";
  }): HSMKeyMetadata[] {
    const keys: HSMKeyMetadata[] = [];

    for (const entry of this.keyRegistry.values()) {
      if (filter?.state && entry.state !== filter.state) continue;
      if (filter?.algorithm && entry.metadata.algorithm !== filter.algorithm) continue;
      if (filter?.objectClass && entry.metadata.objectClass !== filter.objectClass) continue;
      keys.push(entry.metadata);
    }

    return keys;
  }

  /**
   * Get key handle for cryptographic operations
   */
  getKeyHandle(keyId: string, keyType: "public" | "private" | "secret"): number {
    const entry = this.keyRegistry.get(keyId);
    if (!entry) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    if (entry.state !== "ACTIVE") {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key '${keyId}' is not active (state: ${entry.state})`
      );
    }

    switch (keyType) {
      case "public":
        if (!entry.publicKeyHandle) {
          throw new HSMError(
            HSMErrorCode.KEY_NOT_FOUND,
            `Public key handle not available for '${keyId}'`
          );
        }
        return entry.publicKeyHandle;
      case "private":
        if (!entry.privateKeyHandle) {
          throw new HSMError(
            HSMErrorCode.KEY_NOT_FOUND,
            `Private key handle not available for '${keyId}'`
          );
        }
        return entry.privateKeyHandle;
      case "secret":
        if (!entry.secretKeyHandle) {
          throw new HSMError(
            HSMErrorCode.KEY_NOT_FOUND,
            `Secret key handle not available for '${keyId}'`
          );
        }
        return entry.secretKeyHandle;
    }
  }

  // ===========================================================================
  // KEY ROTATION
  // ===========================================================================

  /**
   * Rotate a key
   */
  async rotateKey(request: HSMKeyRotationRequest): Promise<HSMKeyRotationResult> {
    this.ensureInitialized();

    const oldEntry = this.keyRegistry.get(request.oldKeyId);
    if (!oldEntry) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key '${request.oldKeyId}' not found`
      );
    }

    if (oldEntry.state !== "ACTIVE") {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key '${request.oldKeyId}' is not active`
      );
    }

    const oldMetadata = oldEntry.metadata;
    const now = new Date();

    // Generate new key with same parameters
    const newLabel = request.newLabel || `${oldMetadata.label}-rotated-${Date.now()}`;

    let newMetadata: HSMKeyMetadata;
    if (oldMetadata.objectClass === "SECRET_KEY") {
      newMetadata = await this.generateSymmetricKey({
        label: newLabel,
        algorithm: oldMetadata.algorithm,
        usage: oldMetadata.usage,
        extractable: oldMetadata.extractable,
      });
    } else {
      const keyPair = await this.generateKeyPair({
        label: newLabel,
        algorithm: oldMetadata.algorithm,
        usage: oldMetadata.usage,
        extractable: oldMetadata.extractable,
      });
      newMetadata = keyPair.metadata;
    }

    // Update old key status
    let oldKeyStatus: "RETAINED" | "DISABLED" | "DELETED";
    if (request.retainOldKey) {
      // Keep old key but mark rotation
      oldEntry.rotatedTo = newMetadata.id;
      if (request.gracePeriodDays) {
        oldEntry.metadata.expiresAt = new Date(
          now.getTime() + request.gracePeriodDays * 24 * 60 * 60 * 1000
        );
      }
      oldKeyStatus = "RETAINED";
    } else {
      // Deactivate old key
      oldEntry.state = "DEACTIVATED";
      const deactivateEvent: HSMKeyLifecycleEvent = {
        eventId: this.generateEventId(),
        keyId: request.oldKeyId,
        eventType: "DEACTIVATED",
        oldState: "ACTIVE",
        newState: "DEACTIVATED",
        timestamp: now,
        actorId: this.actorId,
        reason: "Key rotation",
      };
      oldEntry.lifecycleEvents.push(deactivateEvent);
      oldKeyStatus = "DISABLED";
    }

    // Update new key with rotation info
    const newEntry = this.keyRegistry.get(newMetadata.id)!;
    newEntry.rotatedFrom = request.oldKeyId;

    // Add rotation event
    const rotateEvent: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId: newMetadata.id,
      eventType: "ROTATED",
      newState: "ACTIVE",
      timestamp: now,
      actorId: this.actorId,
      reason: `Rotated from key '${request.oldKeyId}'`,
    };
    newEntry.lifecycleEvents.push(rotateEvent);

    return {
      newKey: newMetadata,
      oldKey: oldMetadata,
      oldKeyStatus,
      rotatedAt: now,
    };
  }

  // ===========================================================================
  // KEY LIFECYCLE
  // ===========================================================================

  /**
   * Activate a key
   */
  async activateKey(keyId: string): Promise<void> {
    const entry = this.keyRegistry.get(keyId);
    if (!entry) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    if (entry.state !== "PRE_ACTIVE" && entry.state !== "DEACTIVATED") {
      throw new HSMError(
        HSMErrorCode.INTERNAL_ERROR,
        `Cannot activate key in state '${entry.state}'`
      );
    }

    const oldState = entry.state;
    entry.state = "ACTIVE";

    const event: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId,
      eventType: "ACTIVATED",
      oldState,
      newState: "ACTIVE",
      timestamp: new Date(),
      actorId: this.actorId,
    };
    entry.lifecycleEvents.push(event);
  }

  /**
   * Deactivate a key
   */
  async deactivateKey(keyId: string, reason?: string): Promise<void> {
    const entry = this.keyRegistry.get(keyId);
    if (!entry) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    if (entry.state !== "ACTIVE") {
      throw new HSMError(
        HSMErrorCode.INTERNAL_ERROR,
        `Cannot deactivate key in state '${entry.state}'`
      );
    }

    entry.state = "DEACTIVATED";

    const event: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId,
      eventType: "DEACTIVATED",
      oldState: "ACTIVE",
      newState: "DEACTIVATED",
      timestamp: new Date(),
      actorId: this.actorId,
      reason,
    };
    entry.lifecycleEvents.push(event);
  }

  /**
   * Mark a key as compromised
   */
  async markCompromised(keyId: string, reason: string): Promise<void> {
    const entry = this.keyRegistry.get(keyId);
    if (!entry) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    const oldState = entry.state;
    entry.state = "COMPROMISED";

    const event: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId,
      eventType: "COMPROMISED",
      oldState,
      newState: "COMPROMISED",
      timestamp: new Date(),
      actorId: this.actorId,
      reason,
    };
    entry.lifecycleEvents.push(event);
  }

  /**
   * Destroy a key
   */
  async destroyKey(keyId: string, reason?: string): Promise<void> {
    this.ensureInitialized();

    const entry = this.keyRegistry.get(keyId);
    if (!entry) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    // Destroy objects in HSM
    if (entry.publicKeyHandle) {
      await this.pkcs11.destroyObject(entry.publicKeyHandle);
    }
    if (entry.privateKeyHandle) {
      await this.pkcs11.destroyObject(entry.privateKeyHandle);
    }
    if (entry.secretKeyHandle) {
      await this.pkcs11.destroyObject(entry.secretKeyHandle);
    }

    const oldState = entry.state;
    const newState = oldState === "COMPROMISED" ? "DESTROYED_COMPROMISED" : "DESTROYED";
    entry.state = newState as HSMKeyState;

    const event: HSMKeyLifecycleEvent = {
      eventId: this.generateEventId(),
      keyId,
      eventType: "DESTROYED",
      oldState,
      newState,
      timestamp: new Date(),
      actorId: this.actorId,
      reason,
    };
    entry.lifecycleEvents.push(event);
  }

  /**
   * Get key state
   */
  getKeyState(keyId: string): HSMKeyState | undefined {
    return this.keyRegistry.get(keyId)?.state;
  }

  /**
   * Get key lifecycle events
   */
  getKeyLifecycleEvents(keyId: string): HSMKeyLifecycleEvent[] {
    return this.keyRegistry.get(keyId)?.lifecycleEvents || [];
  }

  /**
   * Check if key is expired
   */
  isKeyExpired(keyId: string): boolean {
    const entry = this.keyRegistry.get(keyId);
    if (!entry?.metadata.expiresAt) {
      return false;
    }
    return new Date() > entry.metadata.expiresAt;
  }

  /**
   * Get expired keys
   */
  getExpiredKeys(): HSMKeyMetadata[] {
    const expired: HSMKeyMetadata[] = [];
    const now = new Date();

    for (const entry of this.keyRegistry.values()) {
      if (entry.metadata.expiresAt && now > entry.metadata.expiresAt) {
        expired.push(entry.metadata);
      }
    }

    return expired;
  }

  // ===========================================================================
  // PKCS#11 ACCESS
  // ===========================================================================

  /**
   * Get the underlying PKCS#11 interface
   */
  getPKCS11Interface(): PKCS11Interface {
    return this.pkcs11;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new HSMError(
        HSMErrorCode.NOT_INITIALIZED,
        "Key manager not initialized"
      );
    }
  }

  private generateKeyId(): string {
    return `key_${Date.now()}_${randomBytes(8).toString("hex")}`;
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${randomBytes(4).toString("hex")}`;
  }

  private algorithmToPKCS11(
    algorithm: HSMKeyAlgorithm
  ): { mechanism: PKCS11MechanismType; keyType: PKCS11KeyType; keySize: number } {
    switch (algorithm) {
      case "RSA-2048":
        return { mechanism: "RSA_PKCS_KEY_PAIR_GEN", keyType: "RSA", keySize: 2048 };
      case "RSA-4096":
        return { mechanism: "RSA_PKCS_KEY_PAIR_GEN", keyType: "RSA", keySize: 4096 };
      case "ECDSA-P256":
      case "ECDSA-SECP256K1":
        return { mechanism: "EC_KEY_PAIR_GEN", keyType: "EC", keySize: 256 };
      case "ECDSA-P384":
        return { mechanism: "EC_KEY_PAIR_GEN", keyType: "EC", keySize: 384 };
      case "ECDSA-P521":
        return { mechanism: "EC_KEY_PAIR_GEN", keyType: "EC", keySize: 521 };
      case "AES-128":
        return { mechanism: "AES_KEY_GEN", keyType: "AES", keySize: 128 };
      case "AES-256":
        return { mechanism: "AES_KEY_GEN", keyType: "AES", keySize: 256 };
      case "HMAC-SHA256":
      case "HMAC-SHA384":
      case "HMAC-SHA512":
        return { mechanism: "AES_KEY_GEN", keyType: "GENERIC_SECRET", keySize: 256 };
      default:
        throw new HSMError(
          HSMErrorCode.UNSUPPORTED_ALGORITHM,
          `Unsupported algorithm: ${algorithm}`
        );
    }
  }

  private derToPem(der: Buffer, type: string): string {
    const base64 = der.toString("base64");
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 64) {
      lines.push(base64.slice(i, i + 64));
    }
    return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
  }
}
