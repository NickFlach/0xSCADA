/**
 * HSM/PKCS#11 Signing Interface
 * 
 * Interface for signing Merkle roots. Includes software signer for dev mode
 * and structure ready for real HSM/PKCS#11 integration.
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { createSign, createVerify, createPublicKey, generateKeyPairSync } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { Pkcs11jsProvider, type Pkcs11Provider } from './pkcs11-provider';

/** Optional dependency injection for signer construction (e.g. a test PKCS#11 provider). */
export interface SignerDeps {
  pkcs11Provider?: Pkcs11Provider;
}

/**
 * Strip leading zero bytes to produce the minimal big-endian encoding a JWK
 * requires, keeping at least one byte. PKCS#11 CKA_MODULUS/CKA_PUBLIC_EXPONENT
 * may arrive DER-padded with a leading 0x00 on some modules.
 */
function stripLeadingZeros(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

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
  // Keys are generated with PEM encoding, so both halves are PEM strings.
  private keyPairs: Map<string, { publicKey: string; privateKey: string }> = new Map();
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

    // Keys are generated with PEM encoding, so publicKey is already an
    // SPKI/PEM string (no KeyObject.export available).
    return keyPair.publicKey;
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
 * PKCS#11 HSM signer (#482).
 *
 * Signs Merkle roots with an RSA key that lives inside a PKCS#11 module (a real
 * HSM, or SoftHSMv2 in CI) using the CKM_SHA256_RSA_PKCS mechanism. The private
 * key never leaves the token; signatures are verified with the public key
 * extracted from the token, and are byte-compatible with SoftwareSigner /
 * Node's RSA-SHA256, so downstream verification (the relayer) is unchanged.
 *
 * The raw PKCS#11 session is owned by an injectable Pkcs11Provider — the
 * production Pkcs11jsProvider (native `pkcs11js`) by default, or an in-memory
 * emulator in tests.
 */
export class PKCS11Signer extends BaseSigner {
  private provider: Pkcs11Provider;
  /** keyId → cached extracted SPKI public key PEM */
  private publicKeyCache = new Map<string, string>();

  constructor(config: HSMConfig, provider?: Pkcs11Provider) {
    super({ ...config, mode: 'pkcs11' });
    this.provider = provider ?? new Pkcs11jsProvider();
  }

  private defaultKeyId(keyId?: string): string {
    const id = keyId ?? this.config.keyId ?? 'default';
    return id;
  }

  async initialize(): Promise<void> {
    await this.provider.open({
      library: this.config.pkcs11Library ?? '',
      slot: this.config.slot ?? 0,
      pin: this.config.pin ?? '',
    });
  }

  async sign(data: string, keyId?: string): Promise<SignatureResult> {
    const id = this.defaultKeyId(keyId);
    const handle = await this.provider.findPrivateKeyHandle(id);
    if (!handle) {
      throw new Error(`PKCS#11: private key not found for keyId "${id}"`);
    }
    const signature = await this.provider.sign(handle, Buffer.from(data, 'utf8'));
    return {
      signature: signature.toString('hex'),
      algorithm: this.config.algorithm,
      keyId: id,
      timestamp: Date.now(),
      merkleRoot: data,
    };
  }

  async verify(data: string, signatureResult: SignatureResult): Promise<SignatureVerification> {
    const base = {
      keyId: signatureResult.keyId,
      algorithm: signatureResult.algorithm,
      timestamp: signatureResult.timestamp,
    };
    try {
      const publicKeyPem = await this.getPublicKey(signatureResult.keyId);
      const verify = createVerify('RSA-SHA256');
      verify.update(data);
      verify.end();
      const valid = verify.verify(publicKeyPem, signatureResult.signature, 'hex');
      return { valid, ...base };
    } catch {
      return { valid: false, ...base };
    }
  }

  async getPublicKey(keyId?: string): Promise<string> {
    const id = this.defaultKeyId(keyId);
    const cached = this.publicKeyCache.get(id);
    if (cached) return cached;

    const pub = await this.provider.findPublicKey(id);
    if (!pub) {
      throw new Error(`PKCS#11: public key not found for keyId "${id}"`);
    }
    // Build an SPKI PEM from the raw RSA modulus + exponent via JWK import —
    // avoids hand-rolling DER. JWK base64url requires the MINIMAL big-endian
    // encoding (no leading zeros); some PKCS#11 modules return CKA_MODULUS with
    // a DER-style leading 0x00, so strip it — otherwise the JWK import produces
    // a corrupt key (SoftHSM returns minimal bytes, so this only bites vendor
    // HSMs and would be missed by the emulator).
    const jwk = {
      kty: 'RSA',
      n: stripLeadingZeros(pub.modulus).toString('base64url'),
      e: stripLeadingZeros(pub.exponent).toString('base64url'),
    };
    const pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string;
    this.publicKeyCache.set(id, pem);
    return pem;
  }

  async listKeys(): Promise<KeyInfo[]> {
    const labels = await this.provider.listKeyLabels();
    const keys: KeyInfo[] = [];
    for (const label of labels) {
      let publicKey = '';
      try {
        publicKey = await this.getPublicKey(label);
      } catch {
        // A label without an extractable public key is still listed.
      }
      keys.push({
        keyId: label,
        algorithm: this.config.algorithm,
        publicKey,
        created: Date.now(),
        mode: 'pkcs11',
      });
    }
    return keys;
  }

  async cleanup(): Promise<void> {
    this.publicKeyCache.clear();
    await this.provider.close();
  }
}

/**
 * Factory for creating appropriate signer based on configuration
 */
export class HSMSignerFactory {
  static createSigner(config: HSMConfig, deps: SignerDeps = {}): BaseSigner {
    switch (config.mode) {
      case 'software':
        return new SoftwareSigner(config);
      case 'pkcs11':
        return new PKCS11Signer(config, deps.pkcs11Provider);
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

  constructor(config: HSMConfig, deps: SignerDeps = {}) {
    this.signer = HSMSignerFactory.createSigner(config, deps);
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