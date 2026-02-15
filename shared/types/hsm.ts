/**
 * HSM Types — Shared type definitions for Hardware Security Module operations
 *
 * Issue #151 — Expose HSM operations to kernel crypto subsystem
 */

// =============================================================================
// KEY TYPES
// =============================================================================

export type HSMKeyAlgorithm = "rsa-2048" | "rsa-4096" | "ecdsa-p256" | "ecdsa-secp256k1" | "ed25519";
export type HSMKeyUsage = "sign" | "verify" | "encrypt" | "decrypt" | "wrap" | "unwrap";
export type HSMKeyState = "active" | "deactivated" | "compromised" | "destroyed" | "pre-active";

export interface HSMKeyHandle {
  id: string;
  algorithm: HSMKeyAlgorithm;
  usage: HSMKeyUsage[];
  state: HSMKeyState;
  createdAt: number;
  expiresAt?: number;
  label: string;
  extractable: boolean;
}

export interface HSMKeyPairResult {
  publicKey: HSMKeyHandle;
  privateKey: HSMKeyHandle;
  publicKeyPem: string;
}

// =============================================================================
// OPERATION TYPES
// =============================================================================

export interface HSMSignRequest {
  keyId: string;
  data: Uint8Array;
  algorithm: "sha256" | "sha384" | "sha512" | "keccak256";
}

export interface HSMSignResult {
  signature: Uint8Array;
  keyId: string;
  algorithm: string;
  timestamp: number;
}

export interface HSMVerifyRequest {
  keyId: string;
  data: Uint8Array;
  signature: Uint8Array;
  algorithm: "sha256" | "sha384" | "sha512" | "keccak256";
}

export interface HSMVerifyResult {
  valid: boolean;
  keyId: string;
  timestamp: number;
}

export interface HSMEncryptRequest {
  keyId: string;
  plaintext: Uint8Array;
  aad?: Uint8Array; // additional authenticated data
}

export interface HSMEncryptResult {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyId: string;
}

export interface HSMDecryptRequest {
  keyId: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  aad?: Uint8Array;
}

// =============================================================================
// KEY ROTATION
// =============================================================================

export interface HSMKeyRotationPolicy {
  keyId: string;
  rotationIntervalDays: number;
  autoRotate: boolean;
  retainOldKeyDays: number;
  notifyBeforeDays: number;
}

export interface HSMKeyRotationResult {
  oldKeyId: string;
  newKeyId: string;
  rotatedAt: number;
  oldKeyState: HSMKeyState;
}

// =============================================================================
// AUDIT
// =============================================================================

export interface HSMAuditEntry {
  id: string;
  operation: string;
  keyId?: string;
  timestamp: number;
  success: boolean;
  error?: string;
  metadata: Record<string, string>;
}

// =============================================================================
// PROVIDER ABSTRACTION
// =============================================================================

export type HSMProviderType = "pkcs11" | "aws-cloudhsm" | "azure-keyvault" | "gcp-kms" | "software";

export interface HSMProviderConfig {
  type: HSMProviderType;
  endpoint?: string;
  credentials?: Record<string, string>;
  options?: Record<string, unknown>;
}

/**
 * Abstract HSM provider interface. Implemented by hardware-specific
 * backends and the software fallback.
 */
export interface IHSMProvider {
  readonly providerType: HSMProviderType;
  initialize(config: HSMProviderConfig): Promise<void>;
  shutdown(): Promise<void>;

  generateKeyPair(algorithm: HSMKeyAlgorithm, label: string, usage: HSMKeyUsage[]): Promise<HSMKeyPairResult>;
  getKey(keyId: string): Promise<HSMKeyHandle | null>;
  listKeys(): Promise<HSMKeyHandle[]>;
  destroyKey(keyId: string): Promise<void>;

  sign(request: HSMSignRequest): Promise<HSMSignResult>;
  verify(request: HSMVerifyRequest): Promise<HSMVerifyResult>;
  encrypt(request: HSMEncryptRequest): Promise<HSMEncryptResult>;
  decrypt(request: HSMDecryptRequest): Promise<Uint8Array>;

  rotateKey(keyId: string): Promise<HSMKeyRotationResult>;
  getAuditLog(keyId?: string, limit?: number): Promise<HSMAuditEntry[]>;
}
