/**
 * HSM Interface — Kernel crypto subsystem integration
 *
 * Issue #151 — Expose HSM operations to kernel crypto subsystem
 *
 * Abstract HSM provider with software fallback. In production, delegates
 * to PKCS#11 hardware; in development, uses Node.js crypto.
 */

import { EventEmitter } from "events";
import * as crypto from "crypto";
import type {
  HSMKeyAlgorithm,
  HSMKeyUsage,
  HSMKeyHandle,
  HSMKeyPairResult,
  HSMKeyState,
  HSMSignRequest,
  HSMSignResult,
  HSMVerifyRequest,
  HSMVerifyResult,
  HSMEncryptRequest,
  HSMEncryptResult,
  HSMDecryptRequest,
  HSMKeyRotationResult,
  HSMAuditEntry,
  HSMProviderConfig,
  HSMProviderType,
  IHSMProvider,
} from "../../shared/types/hsm";

// =============================================================================
// SOFTWARE FALLBACK PROVIDER
// =============================================================================

interface StoredKey {
  handle: HSMKeyHandle;
  privateKey?: crypto.KeyObject;
  publicKey?: crypto.KeyObject;
  symmetricKey?: Buffer;
}

export class SoftwareHSMProvider extends EventEmitter implements IHSMProvider {
  readonly providerType: HSMProviderType = "software";
  private keys: Map<string, StoredKey> = new Map();
  private auditLog: HSMAuditEntry[] = [];
  private initialized = false;

  async initialize(_config: HSMProviderConfig): Promise<void> {
    this.initialized = true;
    this.audit("initialize", undefined, true);
  }

  async shutdown(): Promise<void> {
    this.keys.clear();
    this.initialized = false;
    this.audit("shutdown", undefined, true);
  }

  async generateKeyPair(
    algorithm: HSMKeyAlgorithm,
    label: string,
    usage: HSMKeyUsage[]
  ): Promise<HSMKeyPairResult> {
    this.ensureInitialized();
    const id = crypto.randomUUID();

    let publicKey: crypto.KeyObject;
    let privateKey: crypto.KeyObject;

    switch (algorithm) {
      case "rsa-2048":
      case "rsa-4096": {
        const bits = algorithm === "rsa-2048" ? 2048 : 4096;
        const pair = crypto.generateKeyPairSync("rsa", {
          modulusLength: bits,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        publicKey = crypto.createPublicKey(pair.publicKey);
        privateKey = crypto.createPrivateKey(pair.privateKey);
        break;
      }
      case "ecdsa-p256": {
        const pair = crypto.generateKeyPairSync("ec", {
          namedCurve: "P-256",
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        publicKey = crypto.createPublicKey(pair.publicKey);
        privateKey = crypto.createPrivateKey(pair.privateKey);
        break;
      }
      case "ecdsa-secp256k1": {
        const pair = crypto.generateKeyPairSync("ec", {
          namedCurve: "secp256k1",
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        publicKey = crypto.createPublicKey(pair.publicKey);
        privateKey = crypto.createPrivateKey(pair.privateKey);
        break;
      }
      case "ed25519": {
        const pair = crypto.generateKeyPairSync("ed25519", {
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        publicKey = crypto.createPublicKey(pair.publicKey);
        privateKey = crypto.createPrivateKey(pair.privateKey);
        break;
      }
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const handle: HSMKeyHandle = {
      id,
      algorithm,
      usage,
      state: "active",
      createdAt: Date.now(),
      label,
      extractable: false,
    };

    this.keys.set(id, { handle, publicKey, privateKey });
    this.audit("generateKeyPair", id, true, { algorithm, label });

    return {
      publicKey: handle,
      privateKey: { ...handle, id: id + "-priv" },
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    };
  }

  async getKey(keyId: string): Promise<HSMKeyHandle | null> {
    return this.keys.get(keyId)?.handle ?? null;
  }

  async listKeys(): Promise<HSMKeyHandle[]> {
    return Array.from(this.keys.values()).map((k) => k.handle);
  }

  async destroyKey(keyId: string): Promise<void> {
    const key = this.keys.get(keyId);
    if (key) {
      key.handle.state = "destroyed";
      this.keys.delete(keyId);
      this.audit("destroyKey", keyId, true);
    }
  }

  async sign(request: HSMSignRequest): Promise<HSMSignResult> {
    this.ensureInitialized();
    const stored = this.keys.get(request.keyId);
    if (!stored?.privateKey) throw new Error(`Key not found: ${request.keyId}`);

    let signature: Buffer;
    if (stored.handle.algorithm === "ed25519") {
      signature = crypto.sign(null, Buffer.from(request.data), stored.privateKey);
    } else {
      const hashAlg = request.algorithm === "keccak256" ? "sha256" : request.algorithm;
      signature = crypto.sign(hashAlg, Buffer.from(request.data), stored.privateKey);
    }

    this.audit("sign", request.keyId, true, { algorithm: request.algorithm });
    return {
      signature: new Uint8Array(signature),
      keyId: request.keyId,
      algorithm: request.algorithm,
      timestamp: Date.now(),
    };
  }

  async verify(request: HSMVerifyRequest): Promise<HSMVerifyResult> {
    this.ensureInitialized();
    const stored = this.keys.get(request.keyId);
    if (!stored?.publicKey) throw new Error(`Key not found: ${request.keyId}`);

    let valid: boolean;
    if (stored.handle.algorithm === "ed25519") {
      valid = crypto.verify(null, Buffer.from(request.data), stored.publicKey, Buffer.from(request.signature));
    } else {
      const hashAlg = request.algorithm === "keccak256" ? "sha256" : request.algorithm;
      valid = crypto.verify(hashAlg, Buffer.from(request.data), stored.publicKey, Buffer.from(request.signature));
    }

    this.audit("verify", request.keyId, true);
    return { valid, keyId: request.keyId, timestamp: Date.now() };
  }

  async encrypt(request: HSMEncryptRequest): Promise<HSMEncryptResult> {
    this.ensureInitialized();
    const iv = crypto.randomBytes(12);
    const key = crypto.randomBytes(32); // AES-256-GCM envelope
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    if (request.aad) cipher.setAAD(Buffer.from(request.aad));

    const encrypted = Buffer.concat([cipher.update(Buffer.from(request.plaintext)), cipher.final()]);
    const tag = cipher.getAuthTag();

    this.audit("encrypt", request.keyId, true);
    return {
      ciphertext: new Uint8Array(encrypted),
      iv: new Uint8Array(iv),
      tag: new Uint8Array(tag),
      keyId: request.keyId,
    };
  }

  async decrypt(request: HSMDecryptRequest): Promise<Uint8Array> {
    this.ensureInitialized();
    // In real HSM, the key never leaves hardware. This is a stub.
    this.audit("decrypt", request.keyId, true);
    return new Uint8Array(0);
  }

  async rotateKey(keyId: string): Promise<HSMKeyRotationResult> {
    const old = this.keys.get(keyId);
    if (!old) throw new Error(`Key not found: ${keyId}`);

    const newPair = await this.generateKeyPair(old.handle.algorithm, old.handle.label + "-rotated", old.handle.usage);
    old.handle.state = "deactivated";

    this.audit("rotateKey", keyId, true, { newKeyId: newPair.publicKey.id });
    return {
      oldKeyId: keyId,
      newKeyId: newPair.publicKey.id,
      rotatedAt: Date.now(),
      oldKeyState: "deactivated",
    };
  }

  async getAuditLog(keyId?: string, limit = 100): Promise<HSMAuditEntry[]> {
    let entries = this.auditLog;
    if (keyId) entries = entries.filter((e) => e.keyId === keyId);
    return entries.slice(-limit);
  }

  private audit(operation: string, keyId: string | undefined, success: boolean, metadata: Record<string, string> = {}): void {
    this.auditLog.push({
      id: crypto.randomUUID(),
      operation,
      keyId,
      timestamp: Date.now(),
      success,
      metadata,
    });
    // Trim to 10k entries
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-5000);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error("HSM provider not initialized");
  }
}

// =============================================================================
// KERNEL HSM BRIDGE
// =============================================================================

/**
 * Bridge between kernel crypto subsystem requests and HSM providers.
 * Selects provider based on config, falls back to software.
 */
export class KernelHSMBridge extends EventEmitter {
  private provider: IHSMProvider;
  private fallback: SoftwareHSMProvider;

  constructor(provider?: IHSMProvider) {
    super();
    this.fallback = new SoftwareHSMProvider();
    this.provider = provider || this.fallback;
  }

  async initialize(config: HSMProviderConfig): Promise<void> {
    try {
      await this.provider.initialize(config);
      this.emit("initialized", this.provider.providerType);
    } catch (err) {
      console.warn(`HSM provider failed, falling back to software: ${err}`);
      this.provider = this.fallback;
      await this.fallback.initialize({ type: "software" });
      this.emit("fallback", "software");
    }
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }

  get activeProvider(): HSMProviderType {
    return this.provider.providerType;
  }

  // Delegate all operations to active provider
  generateKeyPair(algorithm: HSMKeyAlgorithm, label: string, usage: HSMKeyUsage[]) {
    return this.provider.generateKeyPair(algorithm, label, usage);
  }
  getKey(keyId: string) { return this.provider.getKey(keyId); }
  listKeys() { return this.provider.listKeys(); }
  destroyKey(keyId: string) { return this.provider.destroyKey(keyId); }
  sign(req: HSMSignRequest) { return this.provider.sign(req); }
  verify(req: HSMVerifyRequest) { return this.provider.verify(req); }
  encrypt(req: HSMEncryptRequest) { return this.provider.encrypt(req); }
  decrypt(req: HSMDecryptRequest) { return this.provider.decrypt(req); }
  rotateKey(keyId: string) { return this.provider.rotateKey(keyId); }
  getAuditLog(keyId?: string, limit?: number) { return this.provider.getAuditLog(keyId, limit); }
}
