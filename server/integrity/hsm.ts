/**
 * HSM/PKCS#11 Signing Interface
 * 
 * Interface for signing Merkle roots. Includes software signer for dev mode
 * and structure ready for real HSM/PKCS#11 integration.
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { createSign, createVerify, generateKeyPairSync, KeyPairKeyObjectResult } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface SignatureResult {
  signature: string;
  algorithm: string;
  keyId: string;
  timestamp: number;
  merkleRoot: string;
}

export interface SignatureVerification {
  valid: boolean;
  keyId: string;
  algorithm: string;
  timestamp: number;
}

export interface HSMConfig {
  mode: 'software' | 'pkcs11' | 'hardware';
  keyPath?: string;
  keyId?: string;
  pkcs11Library?: string;
  slot?: number;
  pin?: string;
  algorithm: string;
}

export interface KeyInfo {
  keyId: string;
  algorithm: string;
  publicKey: string;
  created: number;
  mode: string;
}

/**
 * Abstract base class for all signers
 */
export abstract class BaseSigner {
  protected config: HSMConfig;

  constructor(config: HSMConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;
  abstract sign(data: string, keyId?: string): Promise<SignatureResult>;
  abstract verify(data: string, signature: SignatureResult): Promise<SignatureVerification>;
  abstract getPublicKey(keyId?: string): Promise<string>;
  abstract listKeys(): Promise<KeyInfo[]>;
  abstract cleanup(): Promise<void>;
}

/**
 * Software signer for development mode
 * Uses Node.js crypto with local key storage
 */
export class SoftwareSigner extends BaseSigner {
  private keyPairs: Map<string, KeyPairKeyObjectResult> = new Map();
  private keyStorage: string;

  constructor(config: HSMConfig) {
    super({
      ...config,
      mode: 'software',
      algorithm: config.algorithm || 'RS256',
    });
    
    this.keyStorage = config.keyPath || join(process.cwd(), '.keys');
  }

  async initialize(): Promise<void> {
    // Ensure key storage directory exists
    try {
      await fs.mkdir(this.keyStorage, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    // Load or generate default key
    await this.ensureDefaultKey();
  }

  async sign(data: string, keyId: string = 'default'): Promise<SignatureResult> {
    const keyPair = this.keyPairs.get(keyId);
    if (!keyPair) {
      throw new Error(`Key not found: ${keyId}`);
    }

    const algorithm = this.getNodeAlgorithm();
    const sign = createSign(algorithm);
    sign.update(data);
    sign.end();

    const signature = sign.sign(keyPair.privateKey, 'hex');

    return {
      signature,
      algorithm: this.config.algorithm,
      keyId,
      timestamp: Date.now(),
      merkleRoot: data,
    };
  }

  async verify(data: string, signatureResult: SignatureResult): Promise<SignatureVerification> {
    try {
      const keyPair = this.keyPairs.get(signatureResult.keyId);
      if (!keyPair) {
        return {
          valid: false,
          keyId: signatureResult.keyId,
          algorithm: signatureResult.algorithm,
          timestamp: signatureResult.timestamp,
        };
      }

      const algorithm = this.getNodeAlgorithm();
      const verify = createVerify(algorithm);
      verify.update(data);
      verify.end();

      const valid = verify.verify(keyPair.publicKey, signatureResult.signature, 'hex');

      return {
        valid,
        keyId: signatureResult.keyId,
        algorithm: signatureResult.algorithm,
        timestamp: signatureResult.timestamp,
      };
    } catch (error) {
      return {
        valid: false,
        keyId: signatureResult.keyId,
        algorithm: signatureResult.algorithm,
        timestamp: signatureResult.timestamp,
      };
    }
  }

  async getPublicKey(keyId: string = 'default'): Promise<string> {
    const keyPair = this.keyPairs.get(keyId);
    if (!keyPair) {
      throw new Error(`Key not found: ${keyId}`);
    }

    return keyPair.publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
  }

  async listKeys(): Promise<KeyInfo[]> {
    const keys: KeyInfo[] = [];

    for (const [keyId, keyPair] of this.keyPairs) {
      const publicKeyPem = await this.getPublicKey(keyId);
      
      keys.push({
        keyId,
        algorithm: this.config.algorithm,
        publicKey: publicKeyPem,
        created: Date.now(), // In real implementation, store creation time
        mode: 'software',
      });
    }

    return keys;
  }

  async generateKey(keyId: string): Promise<KeyInfo> {
    if (this.keyPairs.has(keyId)) {
      throw new Error(`Key already exists: ${keyId}`);
    }

    const keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    this.keyPairs.set(keyId, keyPair as any);
    
    // Persist key to disk
    await this.saveKey(keyId, keyPair);

    return {
      keyId,
      algorithm: this.config.algorithm,
      publicKey: keyPair.publicKey as string,
      created: Date.now(),
      mode: 'software',
    };
  }

  async cleanup(): Promise<void> {
    this.keyPairs.clear();
  }

  private async ensureDefaultKey(): Promise<void> {
    const defaultKeyPath = join(this.keyStorage, 'default.key');
    const defaultPubPath = join(this.keyStorage, 'default.pub');

    try {
      // Try to load existing key
      const privateKeyPem = await fs.readFile(defaultKeyPath, 'utf8');
      const publicKeyPem = await fs.readFile(defaultPubPath, 'utf8');

      const keyPair = {
        privateKey: privateKeyPem,
        publicKey: publicKeyPem,
      };

      this.keyPairs.set('default', keyPair as any);
    } catch (error) {
      // Generate new default key
      await this.generateKey('default');
    }
  }

  private async saveKey(keyId: string, keyPair: any): Promise<void> {
    const privateKeyPath = join(this.keyStorage, `${keyId}.key`);
    const publicKeyPath = join(this.keyStorage, `${keyId}.pub`);

    await fs.writeFile(privateKeyPath, keyPair.privateKey, 'utf8');
    await fs.writeFile(publicKeyPath, keyPair.publicKey, 'utf8');
  }

  private getNodeAlgorithm(): string {
    switch (this.config.algorithm) {
      case 'RS256':
        return 'RSA-SHA256';
      case 'RS384':
        return 'RSA-SHA384';
      case 'RS512':
        return 'RSA-SHA512';
      default:
        return 'RSA-SHA256';
    }
  }
}

/**
 * PKCS#11 HSM signer (placeholder for real implementation)
 * This would integrate with actual HSM hardware via PKCS#11
 */
export class PKCS11Signer extends BaseSigner {
  constructor(config: HSMConfig) {
    super({
      ...config,
      mode: 'pkcs11',
    });
  }

  async initialize(): Promise<void> {
    // TODO: Initialize PKCS#11 library
    // - Load PKCS#11 library (this.config.pkcs11Library)
    // - Open session with slot (this.config.slot)
    // - Login with PIN (this.config.pin)
    throw new Error('PKCS#11 signer not yet implemented');
  }

  async sign(data: string, keyId?: string): Promise<SignatureResult> {
    // TODO: Implement PKCS#11 signing
    // - Find key object by keyId
    // - Perform cryptographic signing operation
    // - Return signature result
    throw new Error('PKCS#11 signing not yet implemented');
  }

  async verify(data: string, signature: SignatureResult): Promise<SignatureVerification> {
    // TODO: Implement PKCS#11 verification
    throw new Error('PKCS#11 verification not yet implemented');
  }

  async getPublicKey(keyId?: string): Promise<string> {
    // TODO: Extract public key from HSM
    throw new Error('PKCS#11 public key extraction not yet implemented');
  }

  async listKeys(): Promise<KeyInfo[]> {
    // TODO: List keys available in HSM
    throw new Error('PKCS#11 key listing not yet implemented');
  }

  async cleanup(): Promise<void> {
    // TODO: Close PKCS#11 session
  }
}

/**
 * Factory for creating appropriate signer based on configuration
 */
export class HSMSignerFactory {
  static createSigner(config: HSMConfig): BaseSigner {
    switch (config.mode) {
      case 'software':
        return new SoftwareSigner(config);
      case 'pkcs11':
        return new PKCS11Signer(config);
      case 'hardware':
        // Could extend to support other hardware interfaces
        throw new Error('Hardware signer mode not implemented');
      default:
        throw new Error(`Unsupported signer mode: ${config.mode}`);
    }
  }
}

/**
 * High-level HSM manager for Merkle root signing
 */
export class MerkleRootSigner {
  private signer: BaseSigner;
  private isInitialized = false;

  constructor(config: HSMConfig) {
    this.signer = HSMSignerFactory.createSigner(config);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.signer.initialize();
    this.isInitialized = true;
  }

  /**
   * Sign a Merkle root
   */
  async signMerkleRoot(merkleRoot: string, keyId?: string): Promise<SignatureResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.signer.sign(merkleRoot, keyId);
  }

  /**
   * Verify a Merkle root signature
   */
  async verifyMerkleRootSignature(merkleRoot: string, signature: SignatureResult): Promise<SignatureVerification> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.signer.verify(merkleRoot, signature);
  }

  /**
   * Get public key for verification
   */
  async getPublicKey(keyId?: string): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.signer.getPublicKey(keyId);
  }

  /**
   * List available keys
   */
  async listKeys(): Promise<KeyInfo[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.signer.listKeys();
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    await this.signer.cleanup();
    this.isInitialized = false;
  }
}

export default MerkleRootSigner;