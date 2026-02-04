/**
 * Hardware Security Module (HSM) Types
 *
 * Type definitions for HSM integration including PKCS#11 interface,
 * key management, and cryptographic operations.
 */

// =============================================================================
// PKCS#11 TYPES
// =============================================================================

/**
 * PKCS#11 slot information
 */
export interface PKCS11SlotInfo {
  slotId: number;
  slotDescription: string;
  manufacturerId: string;
  flags: {
    tokenPresent: boolean;
    removableDevice: boolean;
    hardwareSlot: boolean;
  };
}

/**
 * PKCS#11 token information
 */
export interface PKCS11TokenInfo {
  label: string;
  manufacturerId: string;
  model: string;
  serialNumber: string;
  flags: {
    initialized: boolean;
    loginRequired: boolean;
    userPinInitialized: boolean;
    readOnly: boolean;
  };
  maxSessionCount: number;
  sessionCount: number;
  maxPinLength: number;
  minPinLength: number;
}

/**
 * PKCS#11 session information
 */
export interface PKCS11SessionInfo {
  slotId: number;
  state: PKCS11SessionState;
  flags: {
    rwSession: boolean;
    serialSession: boolean;
  };
}

/**
 * PKCS#11 session states
 */
export type PKCS11SessionState =
  | "RO_PUBLIC_SESSION"
  | "RO_USER_FUNCTIONS"
  | "RW_PUBLIC_SESSION"
  | "RW_USER_FUNCTIONS"
  | "RW_SO_FUNCTIONS";

/**
 * PKCS#11 user types
 */
export type PKCS11UserType = "USER" | "SO" | "CONTEXT_SPECIFIC";

/**
 * PKCS#11 mechanism types
 */
export type PKCS11MechanismType =
  | "RSA_PKCS"
  | "RSA_PKCS_KEY_PAIR_GEN"
  | "RSA_PKCS_OAEP"
  | "RSA_PKCS_PSS"
  | "ECDSA"
  | "ECDSA_SHA256"
  | "ECDSA_SHA384"
  | "ECDSA_SHA512"
  | "EC_KEY_PAIR_GEN"
  | "AES_KEY_GEN"
  | "AES_CBC"
  | "AES_GCM"
  | "SHA256"
  | "SHA384"
  | "SHA512"
  | "SHA256_HMAC"
  | "SHA384_HMAC"
  | "SHA512_HMAC";

/**
 * PKCS#11 key type
 */
export type PKCS11KeyType =
  | "RSA"
  | "EC"
  | "AES"
  | "DES3"
  | "GENERIC_SECRET";

/**
 * PKCS#11 object class
 */
export type PKCS11ObjectClass =
  | "PUBLIC_KEY"
  | "PRIVATE_KEY"
  | "SECRET_KEY"
  | "CERTIFICATE"
  | "DATA";

// =============================================================================
// HSM KEY TYPES
// =============================================================================

/**
 * HSM key identifier
 */
export interface HSMKeyId {
  /** Unique identifier for the key */
  id: string;
  /** Key label in HSM */
  label: string;
  /** PKCS#11 object handle (session-specific) */
  handle?: number;
}

/**
 * HSM key metadata
 */
export interface HSMKeyMetadata {
  /** Key identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Key type */
  keyType: PKCS11KeyType;
  /** Key algorithm */
  algorithm: HSMKeyAlgorithm;
  /** Key size in bits */
  keySize: number;
  /** Object class */
  objectClass: PKCS11ObjectClass;
  /** Creation timestamp */
  createdAt: Date;
  /** Expiration timestamp (if set) */
  expiresAt?: Date;
  /** Key usage flags */
  usage: HSMKeyUsage;
  /** Whether key is extractable */
  extractable: boolean;
  /** Whether key is persistent */
  persistent: boolean;
  /** Key generation source */
  source: "HSM" | "SOFTWARE" | "IMPORTED";
  /** Custom attributes */
  attributes?: Record<string, unknown>;
}

/**
 * HSM key algorithm
 */
export type HSMKeyAlgorithm =
  | "RSA-2048"
  | "RSA-4096"
  | "ECDSA-P256"
  | "ECDSA-P384"
  | "ECDSA-P521"
  | "ECDSA-SECP256K1"
  | "AES-128"
  | "AES-256"
  | "HMAC-SHA256"
  | "HMAC-SHA384"
  | "HMAC-SHA512";

/**
 * HSM key usage flags
 */
export interface HSMKeyUsage {
  /** Key can be used for signing */
  sign: boolean;
  /** Key can be used for verification */
  verify: boolean;
  /** Key can be used for encryption */
  encrypt: boolean;
  /** Key can be used for decryption */
  decrypt: boolean;
  /** Key can be used for wrapping other keys */
  wrap: boolean;
  /** Key can be used for unwrapping other keys */
  unwrap: boolean;
  /** Key can be used for key derivation */
  derive: boolean;
}

/**
 * Key pair with public and optional private components
 */
export interface HSMKeyPair {
  /** Public key data (exportable) */
  publicKey: {
    /** DER-encoded public key */
    der: Buffer;
    /** PEM-encoded public key */
    pem: string;
    /** Key ID in HSM */
    keyId: HSMKeyId;
  };
  /** Private key identifier (not exportable from HSM) */
  privateKeyId: HSMKeyId;
  /** Key metadata */
  metadata: HSMKeyMetadata;
}

// =============================================================================
// KEY OPERATION TYPES
// =============================================================================

/**
 * Digital signature
 */
export interface HSMSignature {
  /** Signature bytes */
  signature: Buffer;
  /** Algorithm used */
  algorithm: HSMKeyAlgorithm;
  /** Key ID used for signing */
  keyId: string;
  /** Timestamp of signature */
  timestamp: Date;
  /** Hash of signed data */
  dataHash: string;
}

/**
 * Signature verification result
 */
export interface HSMVerificationResult {
  /** Whether signature is valid */
  valid: boolean;
  /** Key ID used for verification */
  keyId: string;
  /** Timestamp of verification */
  timestamp: Date;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Encryption result
 */
export interface HSMEncryptionResult {
  /** Encrypted data */
  ciphertext: Buffer;
  /** Initialization vector (if applicable) */
  iv?: Buffer;
  /** Authentication tag (for AEAD modes) */
  authTag?: Buffer;
  /** Algorithm used */
  algorithm: HSMKeyAlgorithm;
  /** Key ID used for encryption */
  keyId: string;
}

/**
 * Decryption result
 */
export interface HSMDecryptionResult {
  /** Decrypted data */
  plaintext: Buffer;
  /** Whether decryption was successful */
  success: boolean;
  /** Error message if decryption failed */
  error?: string;
}

// =============================================================================
// KEY LIFECYCLE TYPES
// =============================================================================

/**
 * Key generation request
 */
export interface HSMKeyGenerationRequest {
  /** Key label */
  label: string;
  /** Key algorithm */
  algorithm: HSMKeyAlgorithm;
  /** Key usage flags */
  usage: Partial<HSMKeyUsage>;
  /** Whether key should be extractable */
  extractable?: boolean;
  /** Expiration time in days */
  expiresInDays?: number;
  /** Custom attributes */
  attributes?: Record<string, unknown>;
}

/**
 * Key rotation request
 */
export interface HSMKeyRotationRequest {
  /** ID of key to rotate */
  oldKeyId: string;
  /** New key label (optional, defaults to old label with suffix) */
  newLabel?: string;
  /** Whether to retain old key for verification */
  retainOldKey?: boolean;
  /** Grace period in days for old key */
  gracePeriodDays?: number;
}

/**
 * Key rotation result
 */
export interface HSMKeyRotationResult {
  /** New key metadata */
  newKey: HSMKeyMetadata;
  /** Old key metadata */
  oldKey: HSMKeyMetadata;
  /** Old key status */
  oldKeyStatus: "RETAINED" | "DISABLED" | "DELETED";
  /** Rotation timestamp */
  rotatedAt: Date;
}

/**
 * Key state in lifecycle
 */
export type HSMKeyState =
  | "PRE_ACTIVE"     // Generated but not yet activated
  | "ACTIVE"         // In normal use
  | "DEACTIVATED"    // Temporarily disabled
  | "COMPROMISED"    // Security breach detected
  | "DESTROYED"      // Permanently deleted
  | "DESTROYED_COMPROMISED"; // Deleted due to compromise

/**
 * Key lifecycle event
 */
export interface HSMKeyLifecycleEvent {
  /** Event ID */
  eventId: string;
  /** Key ID */
  keyId: string;
  /** Event type */
  eventType: "CREATED" | "ACTIVATED" | "ROTATED" | "DEACTIVATED" | "COMPROMISED" | "DESTROYED";
  /** Old state */
  oldState?: HSMKeyState;
  /** New state */
  newState: HSMKeyState;
  /** Event timestamp */
  timestamp: Date;
  /** Actor who triggered the event */
  actorId: string;
  /** Event reason/details */
  reason?: string;
}

// =============================================================================
// HSM CONFIGURATION TYPES
// =============================================================================

/**
 * HSM configuration
 */
export interface HSMConfig {
  /** Provider type */
  provider: HSMProviderType;
  /** PKCS#11 library path */
  libraryPath?: string;
  /** Slot ID to use */
  slotId?: number;
  /** PIN for user authentication */
  pin?: string;
  /** Whether to use software fallback */
  enableSoftwareFallback: boolean;
  /** Connection timeout in milliseconds */
  connectionTimeout?: number;
  /** Session pool size */
  sessionPoolSize?: number;
  /** Key storage path (for software mode) */
  softwareKeyStorePath?: string;
  /** Audit logging enabled */
  auditEnabled?: boolean;
}

/**
 * HSM provider types
 */
export type HSMProviderType =
  | "PKCS11"           // Generic PKCS#11
  | "SOFTHSM"          // SoftHSM (development/testing)
  | "AWS_CLOUDHSM"     // AWS CloudHSM
  | "AZURE_KEYVAULT"   // Azure Key Vault (HSM-backed)
  | "GCP_CLOUD_KMS"    // GCP Cloud KMS (HSM-backed)
  | "THALES_LUNA"      // Thales Luna HSM
  | "UTIMACO"          // Utimaco HSM
  | "SOFTWARE";        // Software fallback (no HSM)

/**
 * HSM connection status
 */
export interface HSMConnectionStatus {
  /** Whether HSM is connected */
  connected: boolean;
  /** Provider type */
  provider: HSMProviderType;
  /** Slot information (if connected) */
  slotInfo?: PKCS11SlotInfo;
  /** Token information (if connected) */
  tokenInfo?: PKCS11TokenInfo;
  /** Active session count */
  activeSessions: number;
  /** Last error (if any) */
  lastError?: string;
  /** Using software fallback */
  usingSoftwareFallback: boolean;
}

// =============================================================================
// AUDIT TYPES
// =============================================================================

/**
 * HSM audit log entry
 */
export interface HSMAuditLogEntry {
  /** Entry ID */
  id: string;
  /** Timestamp */
  timestamp: Date;
  /** Operation type */
  operation: HSMOperationType;
  /** Key ID (if applicable) */
  keyId?: string;
  /** Key label (if applicable) */
  keyLabel?: string;
  /** Actor ID */
  actorId: string;
  /** Operation result */
  result: "SUCCESS" | "FAILURE";
  /** Error message (if failed) */
  error?: string;
  /** Additional details */
  details?: Record<string, unknown>;
  /** Cryptographic proof of entry */
  signature?: string;
}

/**
 * HSM operation types for audit
 */
export type HSMOperationType =
  | "SESSION_OPEN"
  | "SESSION_CLOSE"
  | "LOGIN"
  | "LOGOUT"
  | "KEY_GENERATE"
  | "KEY_IMPORT"
  | "KEY_EXPORT"
  | "KEY_DESTROY"
  | "KEY_ROTATE"
  | "KEY_ACTIVATE"
  | "KEY_DEACTIVATE"
  | "SIGN"
  | "VERIFY"
  | "ENCRYPT"
  | "DECRYPT"
  | "WRAP"
  | "UNWRAP"
  | "DERIVE";

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * HSM error codes
 */
export enum HSMErrorCode {
  // Connection errors
  CONNECTION_FAILED = "HSM_CONNECTION_FAILED",
  SESSION_FAILED = "HSM_SESSION_FAILED",
  LOGIN_FAILED = "HSM_LOGIN_FAILED",
  TIMEOUT = "HSM_TIMEOUT",

  // Key errors
  KEY_NOT_FOUND = "HSM_KEY_NOT_FOUND",
  KEY_ALREADY_EXISTS = "HSM_KEY_ALREADY_EXISTS",
  KEY_GENERATION_FAILED = "HSM_KEY_GENERATION_FAILED",
  KEY_IMPORT_FAILED = "HSM_KEY_IMPORT_FAILED",
  KEY_EXPIRED = "HSM_KEY_EXPIRED",
  KEY_COMPROMISED = "HSM_KEY_COMPROMISED",

  // Operation errors
  SIGN_FAILED = "HSM_SIGN_FAILED",
  VERIFY_FAILED = "HSM_VERIFY_FAILED",
  ENCRYPT_FAILED = "HSM_ENCRYPT_FAILED",
  DECRYPT_FAILED = "HSM_DECRYPT_FAILED",

  // Permission errors
  PERMISSION_DENIED = "HSM_PERMISSION_DENIED",
  INVALID_PIN = "HSM_INVALID_PIN",

  // Configuration errors
  INVALID_CONFIG = "HSM_INVALID_CONFIG",
  UNSUPPORTED_ALGORITHM = "HSM_UNSUPPORTED_ALGORITHM",

  // General errors
  INTERNAL_ERROR = "HSM_INTERNAL_ERROR",
  NOT_INITIALIZED = "HSM_NOT_INITIALIZED",
  SOFTWARE_FALLBACK_DISABLED = "HSM_SOFTWARE_FALLBACK_DISABLED",
}

/**
 * HSM error class
 */
export class HSMError extends Error {
  constructor(
    public readonly code: HSMErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HSMError";
  }
}
