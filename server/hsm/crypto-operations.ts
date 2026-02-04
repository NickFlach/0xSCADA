/**
 * HSM Cryptographic Operations
 *
 * Provides high-level cryptographic operations using HSM-backed keys including
 * digital signing, verification, encryption, and decryption.
 */

import { createHash } from "crypto";
import { PKCS11Interface } from "./pkcs11-interface";
import { HSMKeyManager } from "./key-manager";
import {
  type HSMConfig,
  type HSMSignature,
  type HSMVerificationResult,
  type HSMEncryptionResult,
  type HSMDecryptionResult,
  type HSMKeyAlgorithm,
  type PKCS11MechanismType,
  HSMError,
  HSMErrorCode,
} from "./types";

// =============================================================================
// CRYPTO OPERATIONS SERVICE
// =============================================================================

/**
 * HSM Cryptographic Operations Service
 */
export class HSMCryptoOperations {
  private keyManager: HSMKeyManager;
  private pkcs11: PKCS11Interface;
  private initialized: boolean = false;

  constructor(keyManager: HSMKeyManager) {
    this.keyManager = keyManager;
    this.pkcs11 = keyManager.getPKCS11Interface();
  }

  /**
   * Initialize the crypto operations service
   */
  async initialize(): Promise<void> {
    if (!this.pkcs11.isInitialized()) {
      throw new HSMError(
        HSMErrorCode.NOT_INITIALIZED,
        "Key manager must be initialized before crypto operations"
      );
    }
    this.initialized = true;
  }

  // ===========================================================================
  // DIGITAL SIGNATURES
  // ===========================================================================

  /**
   * Sign data using an HSM key
   */
  async sign(
    keyId: string,
    data: Buffer | string,
    algorithm?: HSMKeyAlgorithm
  ): Promise<HSMSignature> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);
    if (!metadata) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    if (!metadata.usage.sign) {
      throw new HSMError(
        HSMErrorCode.PERMISSION_DENIED,
        `Key '${keyId}' is not authorized for signing`
      );
    }

    // Check key state
    const state = this.keyManager.getKeyState(keyId);
    if (state !== "ACTIVE") {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key '${keyId}' is not active (state: ${state})`
      );
    }

    // Check key expiration
    if (this.keyManager.isKeyExpired(keyId)) {
      throw new HSMError(HSMErrorCode.KEY_EXPIRED, `Key '${keyId}' has expired`);
    }

    const dataBuffer = typeof data === "string" ? Buffer.from(data) : data;
    const dataHash = createHash("sha256").update(dataBuffer).digest("hex");

    // Get key handle
    const keyHandle = this.keyManager.getKeyHandle(
      keyId,
      metadata.objectClass === "SECRET_KEY" ? "secret" : "private"
    );

    // Determine signing mechanism
    const mechanism = this.algorithmToSignMechanism(algorithm || metadata.algorithm);

    // Sign via PKCS#11
    const signature = await this.pkcs11.sign(mechanism, keyHandle, dataBuffer);

    return {
      signature,
      algorithm: algorithm || metadata.algorithm,
      keyId,
      timestamp: new Date(),
      dataHash,
    };
  }

  /**
   * Sign a hash directly (for pre-hashed data)
   */
  async signHash(
    keyId: string,
    hash: Buffer | string,
    algorithm?: HSMKeyAlgorithm
  ): Promise<HSMSignature> {
    this.ensureInitialized();

    const hashBuffer = typeof hash === "string" ? Buffer.from(hash, "hex") : hash;

    if (hashBuffer.length !== 32 && hashBuffer.length !== 48 && hashBuffer.length !== 64) {
      throw new HSMError(
        HSMErrorCode.SIGN_FAILED,
        "Hash must be 32, 48, or 64 bytes"
      );
    }

    return this.sign(keyId, hashBuffer, algorithm);
  }

  /**
   * Verify a signature
   */
  async verify(
    keyId: string,
    data: Buffer | string,
    signature: Buffer | HSMSignature
  ): Promise<HSMVerificationResult> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);
    if (!metadata) {
      return {
        valid: false,
        keyId,
        timestamp: new Date(),
        error: `Key '${keyId}' not found`,
      };
    }

    if (!metadata.usage.verify) {
      return {
        valid: false,
        keyId,
        timestamp: new Date(),
        error: `Key '${keyId}' is not authorized for verification`,
      };
    }

    const dataBuffer = typeof data === "string" ? Buffer.from(data) : data;
    const sigBuffer = Buffer.isBuffer(signature) ? signature : signature.signature;

    try {
      // Get key handle - use public key for verification if available
      const keyHandle = metadata.objectClass === "SECRET_KEY"
        ? this.keyManager.getKeyHandle(keyId, "secret")
        : this.keyManager.getKeyHandle(keyId, "public");

      // Determine verification mechanism
      const mechanism = this.algorithmToSignMechanism(metadata.algorithm);

      // Verify via PKCS#11
      const valid = await this.pkcs11.verify(mechanism, keyHandle, dataBuffer, sigBuffer);

      return {
        valid,
        keyId,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        valid: false,
        keyId,
        timestamp: new Date(),
        error: error instanceof Error ? error.message : "Verification failed",
      };
    }
  }

  // ===========================================================================
  // ENCRYPTION/DECRYPTION
  // ===========================================================================

  /**
   * Encrypt data using an HSM key
   */
  async encrypt(
    keyId: string,
    plaintext: Buffer | string,
    algorithm?: HSMKeyAlgorithm
  ): Promise<HSMEncryptionResult> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);
    if (!metadata) {
      throw new HSMError(HSMErrorCode.KEY_NOT_FOUND, `Key '${keyId}' not found`);
    }

    if (!metadata.usage.encrypt) {
      throw new HSMError(
        HSMErrorCode.PERMISSION_DENIED,
        `Key '${keyId}' is not authorized for encryption`
      );
    }

    // Check key state
    const state = this.keyManager.getKeyState(keyId);
    if (state !== "ACTIVE") {
      throw new HSMError(
        HSMErrorCode.KEY_NOT_FOUND,
        `Key '${keyId}' is not active (state: ${state})`
      );
    }

    const plaintextBuffer = typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext;

    // Get key handle
    const keyHandle = this.keyManager.getKeyHandle(
      keyId,
      metadata.objectClass === "SECRET_KEY" ? "secret" : "public"
    );

    // Determine encryption mechanism
    const mechanism = this.algorithmToEncryptMechanism(algorithm || metadata.algorithm);

    // Encrypt via PKCS#11
    const { ciphertext, iv } = await this.pkcs11.encrypt(
      mechanism,
      keyHandle,
      plaintextBuffer
    );

    return {
      ciphertext,
      iv,
      algorithm: algorithm || metadata.algorithm,
      keyId,
    };
  }

  /**
   * Decrypt data using an HSM key
   */
  async decrypt(
    keyId: string,
    ciphertext: Buffer,
    iv: Buffer,
    algorithm?: HSMKeyAlgorithm
  ): Promise<HSMDecryptionResult> {
    this.ensureInitialized();

    const metadata = this.keyManager.getKeyMetadata(keyId);
    if (!metadata) {
      return {
        plaintext: Buffer.alloc(0),
        success: false,
        error: `Key '${keyId}' not found`,
      };
    }

    if (!metadata.usage.decrypt) {
      return {
        plaintext: Buffer.alloc(0),
        success: false,
        error: `Key '${keyId}' is not authorized for decryption`,
      };
    }

    // Check key state
    const state = this.keyManager.getKeyState(keyId);
    if (state !== "ACTIVE") {
      return {
        plaintext: Buffer.alloc(0),
        success: false,
        error: `Key '${keyId}' is not active (state: ${state})`,
      };
    }

    try {
      // Get key handle
      const keyHandle = this.keyManager.getKeyHandle(
        keyId,
        metadata.objectClass === "SECRET_KEY" ? "secret" : "private"
      );

      // Determine decryption mechanism
      const mechanism = this.algorithmToEncryptMechanism(algorithm || metadata.algorithm);

      // Decrypt via PKCS#11
      const plaintext = await this.pkcs11.decrypt(mechanism, keyHandle, ciphertext, iv);

      return {
        plaintext,
        success: true,
      };
    } catch (error) {
      return {
        plaintext: Buffer.alloc(0),
        success: false,
        error: error instanceof Error ? error.message : "Decryption failed",
      };
    }
  }

  // ===========================================================================
  // HASHING
  // ===========================================================================

  /**
   * Compute a hash using the HSM
   */
  async hash(data: Buffer | string, algorithm: "SHA256" | "SHA384" | "SHA512" = "SHA256"): Promise<Buffer> {
    this.ensureInitialized();

    const dataBuffer = typeof data === "string" ? Buffer.from(data) : data;
    return this.pkcs11.digest(algorithm, dataBuffer);
  }

  /**
   * Compute a hash and return as hex string
   */
  async hashHex(data: Buffer | string, algorithm: "SHA256" | "SHA384" | "SHA512" = "SHA256"): Promise<string> {
    const hash = await this.hash(data, algorithm);
    return hash.toString("hex");
  }

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  /**
   * Sign multiple data items in batch
   */
  async signBatch(
    keyId: string,
    dataItems: Array<Buffer | string>,
    algorithm?: HSMKeyAlgorithm
  ): Promise<HSMSignature[]> {
    const signatures: HSMSignature[] = [];
    for (const data of dataItems) {
      signatures.push(await this.sign(keyId, data, algorithm));
    }
    return signatures;
  }

  /**
   * Verify multiple signatures in batch
   */
  async verifyBatch(
    verifications: Array<{
      keyId: string;
      data: Buffer | string;
      signature: Buffer | HSMSignature;
    }>
  ): Promise<HSMVerificationResult[]> {
    const results: HSMVerificationResult[] = [];
    for (const { keyId, data, signature } of verifications) {
      results.push(await this.verify(keyId, data, signature));
    }
    return results;
  }

  // ===========================================================================
  // ETHEREUM COMPATIBILITY
  // ===========================================================================

  /**
   * Sign an Ethereum message (EIP-191 personal sign format)
   */
  async signEthereumMessage(
    keyId: string,
    message: string
  ): Promise<{ signature: Buffer; v: number; r: Buffer; s: Buffer }> {
    this.ensureInitialized();

    // Ethereum message prefix
    const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
    const prefixedMessage = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from(message),
    ]);

    // Hash with Keccak256 (simulated with SHA256 for software mode)
    const messageHash = createHash("sha256").update(prefixedMessage).digest();

    // Sign the hash
    const signResult = await this.sign(keyId, messageHash);

    // Extract r, s, v from signature (simplified for software mode)
    const signature = signResult.signature;
    const r = signature.slice(0, 32);
    const s = signature.slice(32, 64);
    const v = 27; // Recovery ID (simplified)

    return { signature, v, r, s };
  }

  /**
   * Sign an Ethereum transaction hash
   */
  async signEthereumTransaction(
    keyId: string,
    transactionHash: Buffer
  ): Promise<{ signature: Buffer; v: number; r: Buffer; s: Buffer }> {
    this.ensureInitialized();

    if (transactionHash.length !== 32) {
      throw new HSMError(
        HSMErrorCode.SIGN_FAILED,
        "Transaction hash must be 32 bytes"
      );
    }

    const signResult = await this.sign(keyId, transactionHash);

    const signature = signResult.signature;
    const r = signature.slice(0, 32);
    const s = signature.slice(32, 64);
    const v = 27;

    return { signature, v, r, s };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new HSMError(
        HSMErrorCode.NOT_INITIALIZED,
        "Crypto operations not initialized"
      );
    }
  }

  private algorithmToSignMechanism(algorithm: HSMKeyAlgorithm): PKCS11MechanismType {
    switch (algorithm) {
      case "RSA-2048":
      case "RSA-4096":
        return "RSA_PKCS_PSS";
      case "ECDSA-P256":
      case "ECDSA-SECP256K1":
        return "ECDSA_SHA256";
      case "ECDSA-P384":
        return "ECDSA_SHA384";
      case "ECDSA-P521":
        return "ECDSA_SHA512";
      case "HMAC-SHA256":
        return "SHA256_HMAC";
      case "HMAC-SHA384":
        return "SHA384_HMAC";
      case "HMAC-SHA512":
        return "SHA512_HMAC";
      default:
        return "ECDSA_SHA256";
    }
  }

  private algorithmToEncryptMechanism(algorithm: HSMKeyAlgorithm): PKCS11MechanismType {
    switch (algorithm) {
      case "RSA-2048":
      case "RSA-4096":
        return "RSA_PKCS_OAEP";
      case "AES-128":
      case "AES-256":
        return "AES_GCM";
      default:
        return "AES_CBC";
    }
  }
}
