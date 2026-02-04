/**
 * PKCS#11 Interface for HSM Communication
 *
 * Provides a standardized interface for communicating with Hardware Security
 * Modules via the PKCS#11 standard. Includes session management, key operations,
 * and cryptographic functions.
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import {
  type PKCS11SlotInfo,
  type PKCS11TokenInfo,
  type PKCS11SessionInfo,
  type PKCS11SessionState,
  type PKCS11UserType,
  type PKCS11MechanismType,
  type PKCS11KeyType,
  type PKCS11ObjectClass,
  type HSMConfig,
  type HSMConnectionStatus,
  HSMError,
  HSMErrorCode,
} from "./types";

// =============================================================================
// PKCS#11 CONSTANTS
// =============================================================================

const CKF_TOKEN_PRESENT = 0x00000001;
const CKF_REMOVABLE_DEVICE = 0x00000002;
const CKF_HW_SLOT = 0x00000004;

const CKU_USER = 1;
const CKU_SO = 0;
const CKU_CONTEXT_SPECIFIC = 2;

const CKS_RO_PUBLIC_SESSION = 0;
const CKS_RO_USER_FUNCTIONS = 1;
const CKS_RW_PUBLIC_SESSION = 2;
const CKS_RW_USER_FUNCTIONS = 3;
const CKS_RW_SO_FUNCTIONS = 4;

// =============================================================================
// SESSION POOL
// =============================================================================

interface PooledSession {
  handle: number;
  slotId: number;
  state: PKCS11SessionState;
  inUse: boolean;
  createdAt: Date;
  lastUsedAt: Date;
}

/**
 * Session pool for managing PKCS#11 sessions
 */
export class PKCS11SessionPool {
  private sessions: Map<number, PooledSession> = new Map();
  private nextHandle: number = 1;
  private maxSessions: number;
  private slotId: number;

  constructor(slotId: number, maxSessions: number = 10) {
    this.slotId = slotId;
    this.maxSessions = maxSessions;
  }

  /**
   * Acquire a session from the pool
   */
  acquire(): PooledSession {
    // Find an available session
    for (const [handle, session] of this.sessions) {
      if (!session.inUse) {
        session.inUse = true;
        session.lastUsedAt = new Date();
        return session;
      }
    }

    // Create new session if pool not full
    if (this.sessions.size < this.maxSessions) {
      const session: PooledSession = {
        handle: this.nextHandle++,
        slotId: this.slotId,
        state: "RW_USER_FUNCTIONS",
        inUse: true,
        createdAt: new Date(),
        lastUsedAt: new Date(),
      };
      this.sessions.set(session.handle, session);
      return session;
    }

    throw new HSMError(
      HSMErrorCode.SESSION_FAILED,
      "No available sessions in pool",
      { maxSessions: this.maxSessions }
    );
  }

  /**
   * Release a session back to the pool
   */
  release(handle: number): void {
    const session = this.sessions.get(handle);
    if (session) {
      session.inUse = false;
    }
  }

  /**
   * Close a specific session
   */
  close(handle: number): void {
    this.sessions.delete(handle);
  }

  /**
   * Close all sessions
   */
  closeAll(): void {
    this.sessions.clear();
  }

  /**
   * Get pool statistics
   */
  getStats(): { total: number; inUse: number; available: number } {
    let inUse = 0;
    for (const session of this.sessions.values()) {
      if (session.inUse) inUse++;
    }
    return {
      total: this.sessions.size,
      inUse,
      available: this.sessions.size - inUse,
    };
  }
}

// =============================================================================
// PKCS#11 INTERFACE
// =============================================================================

/**
 * PKCS#11 interface for HSM communication
 */
export class PKCS11Interface {
  private config: HSMConfig;
  private initialized: boolean = false;
  private sessionPool: PKCS11SessionPool | null = null;
  private loggedIn: boolean = false;
  private slotInfo: PKCS11SlotInfo | null = null;
  private tokenInfo: PKCS11TokenInfo | null = null;

  // Simulated object store for software mode
  private objectStore: Map<number, SimulatedObject> = new Map();
  private nextObjectHandle: number = 1;

  constructor(config: HSMConfig) {
    this.config = config;
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  /**
   * Initialize the PKCS#11 interface
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.config.provider === "SOFTWARE" || this.config.enableSoftwareFallback) {
      // Software mode - no real HSM
      await this.initializeSoftwareMode();
    } else {
      // Real PKCS#11 library
      await this.initializePKCS11();
    }

    this.initialized = true;
  }

  /**
   * Initialize software mode (fallback)
   */
  private async initializeSoftwareMode(): Promise<void> {
    const slotId = this.config.slotId ?? 0;

    this.slotInfo = {
      slotId,
      slotDescription: "Software HSM Emulation Slot",
      manufacturerId: "0xSCADA",
      flags: {
        tokenPresent: true,
        removableDevice: false,
        hardwareSlot: false,
      },
    };

    this.tokenInfo = {
      label: "SoftwareToken",
      manufacturerId: "0xSCADA",
      model: "Software HSM",
      serialNumber: "SOFT-" + randomBytes(4).toString("hex").toUpperCase(),
      flags: {
        initialized: true,
        loginRequired: true,
        userPinInitialized: true,
        readOnly: false,
      },
      maxSessionCount: 256,
      sessionCount: 0,
      maxPinLength: 64,
      minPinLength: 4,
    };

    this.sessionPool = new PKCS11SessionPool(slotId, this.config.sessionPoolSize ?? 10);
  }

  /**
   * Initialize real PKCS#11 library
   */
  private async initializePKCS11(): Promise<void> {
    // In production, this would load the actual PKCS#11 library
    // For now, throw an error indicating HSM is not available
    if (!this.config.libraryPath) {
      if (this.config.enableSoftwareFallback) {
        await this.initializeSoftwareMode();
        return;
      }
      throw new HSMError(
        HSMErrorCode.INVALID_CONFIG,
        "PKCS#11 library path not specified and software fallback disabled"
      );
    }

    // Simulate HSM connection (in production, use native bindings)
    await this.initializeSoftwareMode();
  }

  /**
   * Finalize the PKCS#11 interface
   */
  async finalize(): Promise<void> {
    if (this.loggedIn) {
      await this.logout();
    }

    this.sessionPool?.closeAll();
    this.sessionPool = null;
    this.objectStore.clear();
    this.initialized = false;
  }

  // ===========================================================================
  // SESSION MANAGEMENT
  // ===========================================================================

  /**
   * Open a new session
   */
  async openSession(readWrite: boolean = true): Promise<number> {
    this.ensureInitialized();

    const session = this.sessionPool!.acquire();
    session.state = readWrite ? "RW_PUBLIC_SESSION" : "RO_PUBLIC_SESSION";

    return session.handle;
  }

  /**
   * Close a session
   */
  async closeSession(sessionHandle: number): Promise<void> {
    this.ensureInitialized();
    this.sessionPool!.release(sessionHandle);
  }

  /**
   * Get session info
   */
  async getSessionInfo(sessionHandle: number): Promise<PKCS11SessionInfo> {
    this.ensureInitialized();

    return {
      slotId: this.config.slotId ?? 0,
      state: this.loggedIn ? "RW_USER_FUNCTIONS" : "RW_PUBLIC_SESSION",
      flags: {
        rwSession: true,
        serialSession: true,
      },
    };
  }

  // ===========================================================================
  // LOGIN/LOGOUT
  // ===========================================================================

  /**
   * Login to the token
   */
  async login(pin: string, userType: PKCS11UserType = "USER"): Promise<void> {
    this.ensureInitialized();

    // Validate PIN (in software mode, accept any non-empty PIN)
    if (!pin || pin.length === 0) {
      throw new HSMError(HSMErrorCode.INVALID_PIN, "PIN cannot be empty");
    }

    // In production, validate against actual HSM
    // For software mode, accept configured PIN or any PIN
    if (this.config.pin && pin !== this.config.pin) {
      throw new HSMError(HSMErrorCode.INVALID_PIN, "Invalid PIN");
    }

    this.loggedIn = true;
  }

  /**
   * Logout from the token
   */
  async logout(): Promise<void> {
    this.ensureInitialized();
    this.loggedIn = false;
  }

  // ===========================================================================
  // OBJECT MANAGEMENT
  // ===========================================================================

  /**
   * Create an object (key) in the HSM
   */
  async createObject(attributes: ObjectAttributes): Promise<number> {
    this.ensureLoggedIn();

    const handle = this.nextObjectHandle++;
    const obj: SimulatedObject = {
      handle,
      objectClass: attributes.objectClass,
      keyType: attributes.keyType,
      label: attributes.label,
      id: attributes.id || randomBytes(8).toString("hex"),
      value: attributes.value,
      attributes: { ...attributes },
      createdAt: new Date(),
    };

    this.objectStore.set(handle, obj);
    return handle;
  }

  /**
   * Find objects matching template
   */
  async findObjects(template: Partial<ObjectAttributes>): Promise<number[]> {
    this.ensureLoggedIn();

    const matches: number[] = [];
    for (const [handle, obj] of this.objectStore) {
      if (this.matchesTemplate(obj, template)) {
        matches.push(handle);
      }
    }

    return matches;
  }

  /**
   * Get object attributes
   */
  async getObjectAttributes(
    objectHandle: number,
    attributeTypes: string[]
  ): Promise<Partial<ObjectAttributes>> {
    this.ensureLoggedIn();

    const obj = this.objectStore.get(objectHandle);
    if (!obj) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Object with handle ${objectHandle} not found`
      );
    }

    const result: Partial<ObjectAttributes> = {};
    for (const attrType of attributeTypes) {
      if (attrType in obj.attributes) {
        (result as Record<string, unknown>)[attrType] =
          (obj.attributes as Record<string, unknown>)[attrType];
      }
    }

    return result;
  }

  /**
   * Destroy an object
   */
  async destroyObject(objectHandle: number): Promise<void> {
    this.ensureLoggedIn();

    if (!this.objectStore.has(objectHandle)) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Object with handle ${objectHandle} not found`
      );
    }

    this.objectStore.delete(objectHandle);
  }

  // ===========================================================================
  // KEY GENERATION
  // ===========================================================================

  /**
   * Generate a key pair
   */
  async generateKeyPair(
    mechanism: PKCS11MechanismType,
    publicKeyTemplate: ObjectAttributes,
    privateKeyTemplate: ObjectAttributes
  ): Promise<{ publicKeyHandle: number; privateKeyHandle: number }> {
    this.ensureLoggedIn();

    let keySize = 256;
    let keyType: PKCS11KeyType = "EC";

    // Determine key parameters from mechanism
    switch (mechanism) {
      case "RSA_PKCS_KEY_PAIR_GEN":
        keyType = "RSA";
        keySize = publicKeyTemplate.modulusBits || 2048;
        break;
      case "EC_KEY_PAIR_GEN":
        keyType = "EC";
        keySize = 256; // P-256 default
        break;
      default:
        throw new HSMError(
          HSMErrorCode.UNSUPPORTED_ALGORITHM,
          `Unsupported mechanism: ${mechanism}`
        );
    }

    // Generate simulated keys
    const privateKeyValue = randomBytes(keySize / 8);
    const publicKeyValue = createHash("sha256").update(privateKeyValue).digest();

    // Create public key object
    const publicKeyHandle = await this.createObject({
      ...publicKeyTemplate,
      objectClass: "PUBLIC_KEY",
      keyType,
      value: publicKeyValue,
    });

    // Create private key object
    const privateKeyHandle = await this.createObject({
      ...privateKeyTemplate,
      objectClass: "PRIVATE_KEY",
      keyType,
      value: privateKeyValue,
    });

    return { publicKeyHandle, privateKeyHandle };
  }

  /**
   * Generate a secret key
   */
  async generateSecretKey(
    mechanism: PKCS11MechanismType,
    template: ObjectAttributes
  ): Promise<number> {
    this.ensureLoggedIn();

    let keySize = 32;
    let keyType: PKCS11KeyType = "AES";

    switch (mechanism) {
      case "AES_KEY_GEN":
        keyType = "AES";
        keySize = template.valueLen || 32;
        break;
      default:
        keyType = "GENERIC_SECRET";
        keySize = template.valueLen || 32;
    }

    const keyValue = randomBytes(keySize);

    return this.createObject({
      ...template,
      objectClass: "SECRET_KEY",
      keyType,
      value: keyValue,
    });
  }

  // ===========================================================================
  // CRYPTOGRAPHIC OPERATIONS
  // ===========================================================================

  /**
   * Sign data
   */
  async sign(
    mechanism: PKCS11MechanismType,
    keyHandle: number,
    data: Buffer
  ): Promise<Buffer> {
    this.ensureLoggedIn();

    const keyObj = this.objectStore.get(keyHandle);
    if (!keyObj) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key with handle ${keyHandle} not found`
      );
    }

    if (keyObj.objectClass !== "PRIVATE_KEY" && keyObj.objectClass !== "SECRET_KEY") {
      throw new HSMError(
        HSMErrorCode.SIGN_FAILED,
        "Invalid key type for signing"
      );
    }

    // Simulate signing using HMAC
    const hmac = createHash("sha256")
      .update(keyObj.value!)
      .update(data)
      .digest();

    return hmac;
  }

  /**
   * Verify signature
   */
  async verify(
    mechanism: PKCS11MechanismType,
    keyHandle: number,
    data: Buffer,
    signature: Buffer
  ): Promise<boolean> {
    this.ensureLoggedIn();

    const keyObj = this.objectStore.get(keyHandle);
    if (!keyObj) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key with handle ${keyHandle} not found`
      );
    }

    // For asymmetric verification, we need to find the corresponding private key
    // In software mode, we use the public key value to derive the verification
    let privateKeyValue: Buffer | undefined;

    if (keyObj.objectClass === "PUBLIC_KEY") {
      // Find matching private key by label
      for (const obj of this.objectStore.values()) {
        if (
          obj.objectClass === "PRIVATE_KEY" &&
          obj.label === keyObj.label.replace("-pub", "")
        ) {
          privateKeyValue = obj.value;
          break;
        }
      }
    } else {
      privateKeyValue = keyObj.value;
    }

    if (!privateKeyValue) {
      throw new HSMError(
        HSMErrorCode.VERIFY_FAILED,
        "Cannot find key material for verification"
      );
    }

    // Simulate verification
    const expectedSignature = createHash("sha256")
      .update(privateKeyValue)
      .update(data)
      .digest();

    return signature.equals(expectedSignature);
  }

  /**
   * Encrypt data
   */
  async encrypt(
    mechanism: PKCS11MechanismType,
    keyHandle: number,
    data: Buffer,
    iv?: Buffer
  ): Promise<{ ciphertext: Buffer; iv: Buffer }> {
    this.ensureLoggedIn();

    const keyObj = this.objectStore.get(keyHandle);
    if (!keyObj || !keyObj.value) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key with handle ${keyHandle} not found`
      );
    }

    // Generate IV if not provided
    const actualIv = iv || randomBytes(16);

    // Use AES-256-CBC for encryption
    const key = keyObj.value.length === 32
      ? keyObj.value
      : createHash("sha256").update(keyObj.value).digest();

    const cipher = createCipheriv("aes-256-cbc", key, actualIv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

    return { ciphertext, iv: actualIv };
  }

  /**
   * Decrypt data
   */
  async decrypt(
    mechanism: PKCS11MechanismType,
    keyHandle: number,
    ciphertext: Buffer,
    iv: Buffer
  ): Promise<Buffer> {
    this.ensureLoggedIn();

    const keyObj = this.objectStore.get(keyHandle);
    if (!keyObj || !keyObj.value) {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key with handle ${keyHandle} not found`
      );
    }

    const key = keyObj.value.length === 32
      ? keyObj.value
      : createHash("sha256").update(keyObj.value).digest();

    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return plaintext;
  }

  /**
   * Compute digest/hash
   */
  async digest(mechanism: PKCS11MechanismType, data: Buffer): Promise<Buffer> {
    this.ensureInitialized();

    let algorithm: string;
    switch (mechanism) {
      case "SHA256":
        algorithm = "sha256";
        break;
      case "SHA384":
        algorithm = "sha384";
        break;
      case "SHA512":
        algorithm = "sha512";
        break;
      default:
        throw new HSMError(
          HSMErrorCode.UNSUPPORTED_ALGORITHM,
          `Unsupported digest mechanism: ${mechanism}`
        );
    }

    return createHash(algorithm).update(data).digest();
  }

  // ===========================================================================
  // STATUS AND INFO
  // ===========================================================================

  /**
   * Get slot information
   */
  getSlotInfo(): PKCS11SlotInfo | null {
    return this.slotInfo;
  }

  /**
   * Get token information
   */
  getTokenInfo(): PKCS11TokenInfo | null {
    return this.tokenInfo;
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): HSMConnectionStatus {
    return {
      connected: this.initialized,
      provider: this.config.provider,
      slotInfo: this.slotInfo ?? undefined,
      tokenInfo: this.tokenInfo ?? undefined,
      activeSessions: this.sessionPool?.getStats().inUse ?? 0,
      lastError: undefined,
      usingSoftwareFallback:
        this.config.provider === "SOFTWARE" ||
        (this.config.enableSoftwareFallback && !this.config.libraryPath),
    };
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if logged in
   */
  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new HSMError(
        HSMErrorCode.NOT_INITIALIZED,
        "PKCS#11 interface not initialized"
      );
    }
  }

  private ensureLoggedIn(): void {
    this.ensureInitialized();
    if (!this.loggedIn) {
      throw new HSMError(
        HSMErrorCode.LOGIN_FAILED,
        "Not logged in to HSM"
      );
    }
  }

  private matchesTemplate(
    obj: SimulatedObject,
    template: Partial<ObjectAttributes>
  ): boolean {
    for (const [key, value] of Object.entries(template)) {
      if (key === "value") continue; // Don't match on value
      if ((obj.attributes as Record<string, unknown>)[key] !== value) {
        return false;
      }
    }
    return true;
  }
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface ObjectAttributes {
  objectClass: PKCS11ObjectClass;
  keyType?: PKCS11KeyType;
  label: string;
  id?: string;
  value?: Buffer;
  modulusBits?: number;
  valueLen?: number;
  encrypt?: boolean;
  decrypt?: boolean;
  sign?: boolean;
  verify?: boolean;
  wrap?: boolean;
  unwrap?: boolean;
  derive?: boolean;
  extractable?: boolean;
  sensitive?: boolean;
  token?: boolean;
  private?: boolean;
}

interface SimulatedObject {
  handle: number;
  objectClass: PKCS11ObjectClass;
  keyType?: PKCS11KeyType;
  label: string;
  id: string;
  value?: Buffer;
  attributes: ObjectAttributes;
  createdAt: Date;
}
