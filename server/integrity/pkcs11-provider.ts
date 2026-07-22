/**
 * PKCS#11 provider abstraction (#482)
 *
 * PKCS11Signer talks to an HSM through this small provider interface rather than
 * the raw PKCS#11 C_* API. Two implementations:
 *
 *  - Pkcs11jsProvider: the production path, backed by the `pkcs11js` native
 *    binding against a real PKCS#11 module (SoftHSMv2, or a vendor HSM). Loaded
 *    lazily so the native dependency is optional — absent it throws a clear,
 *    actionable error instead of the former "not implemented".
 *  - InMemoryPkcs11Provider: a faithful emulator (RSA via Node crypto) that
 *    lets the full signer round-trip — session/login/find-key/sign/extract — be
 *    tested without the native library or an HSM. Real-hardware validation is
 *    the SoftHSMv2 CI job.
 *
 * The signing mechanism is CKM_SHA256_RSA_PKCS, which hashes-then-signs exactly
 * like Node's `createSign('RSA-SHA256')`, so signatures are verifiable with the
 * extracted SPKI public key and interoperate with SoftwareSigner's format.
 */

import { generateKeyPairSync, createPublicKey, createSign } from 'crypto';

/** Opaque handle to a private key object inside the HSM session. */
export type Pkcs11KeyHandle = unknown;

export interface Pkcs11OpenConfig {
  library: string;
  slot: number;
  pin: string;
}

export interface Pkcs11PublicKey {
  /** RSA modulus, big-endian bytes */
  modulus: Buffer;
  /** RSA public exponent, big-endian bytes */
  exponent: Buffer;
}

/**
 * Minimal HSM operations the signer needs. Implementations own the raw PKCS#11
 * session lifecycle.
 */
export interface Pkcs11Provider {
  /** Load the module, initialize, open a session, and log in. */
  open(config: Pkcs11OpenConfig): Promise<void>;
  /** Handle to a private key by CKA_LABEL, or null if none. */
  findPrivateKeyHandle(label: string): Promise<Pkcs11KeyHandle | null>;
  /** Public key material (modulus + exponent) by CKA_LABEL, or null. */
  findPublicKey(label: string): Promise<Pkcs11PublicKey | null>;
  /** CKM_SHA256_RSA_PKCS signature over `data`. */
  sign(handle: Pkcs11KeyHandle, data: Buffer): Promise<Buffer>;
  /** Labels of all key pairs visible in the session. */
  listKeyLabels(): Promise<string[]>;
  /** Log out, close the session, finalize. */
  close(): Promise<void>;
}

// ─── Production provider (pkcs11js) ──────────────────────────────────────────

/**
 * Production provider backed by the `pkcs11js` native binding. Requires the
 * optional `pkcs11js` dependency and a PKCS#11 module path (config.library).
 */
export class Pkcs11jsProvider implements Pkcs11Provider {
  private pkcs11: any;
  private session: unknown;
  private opened = false;

  async open(config: Pkcs11OpenConfig): Promise<void> {
    let pkcs11js: any;
    try {
      // Lazy, optional native dependency — not required to build/test the app.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pkcs11js = require('pkcs11js');
    } catch {
      throw new Error(
        'PKCS#11 signing requires the optional `pkcs11js` dependency. Install it (npm i pkcs11js) and provide a PKCS#11 module path (HSMConfig.pkcs11Library).',
      );
    }
    if (!config.library) {
      throw new Error('PKCS#11: no module library path configured (HSMConfig.pkcs11Library)');
    }

    const pkcs11 = new pkcs11js.PKCS11();
    pkcs11.load(config.library);
    pkcs11.C_Initialize();
    const slots = pkcs11.C_GetSlotList(true);
    const slot = slots[config.slot ?? 0];
    if (slot === undefined) {
      throw new Error(`PKCS#11: slot index ${config.slot ?? 0} not present (found ${slots.length} slots)`);
    }
    const session = pkcs11.C_OpenSession(
      slot,
      pkcs11js.CKF_SERIAL_SESSION | pkcs11js.CKF_RW_SESSION,
    );
    pkcs11.C_Login(session, pkcs11js.CKU_USER, config.pin);

    this.pkcs11 = pkcs11;
    this.session = session;
    this.opened = true;
  }

  private ensureOpen(): void {
    if (!this.opened) throw new Error('PKCS#11 provider not open');
  }

  private findHandle(cls: number, label: string): unknown | null {
    const p = this.pkcs11;
    p.C_FindObjectsInit(this.session, [
      { type: p.CKA_CLASS, value: cls },
      { type: p.CKA_LABEL, value: label },
    ]);
    const handle = p.C_FindObjects(this.session);
    p.C_FindObjectsFinal(this.session);
    return handle ?? null;
  }

  async findPrivateKeyHandle(label: string): Promise<Pkcs11KeyHandle | null> {
    this.ensureOpen();
    return this.findHandle(this.pkcs11.CKO_PRIVATE_KEY, label);
  }

  async findPublicKey(label: string): Promise<Pkcs11PublicKey | null> {
    this.ensureOpen();
    const handle = this.findHandle(this.pkcs11.CKO_PUBLIC_KEY, label);
    if (!handle) return null;
    const attrs = this.pkcs11.C_GetAttributeValue(this.session, handle, [
      { type: this.pkcs11.CKA_MODULUS },
      { type: this.pkcs11.CKA_PUBLIC_EXPONENT },
    ]);
    return { modulus: Buffer.from(attrs[0].value), exponent: Buffer.from(attrs[1].value) };
  }

  async sign(handle: Pkcs11KeyHandle, data: Buffer): Promise<Buffer> {
    this.ensureOpen();
    this.pkcs11.C_SignInit(this.session, { mechanism: this.pkcs11.CKM_SHA256_RSA_PKCS }, handle);
    // 2048-bit RSA → 256-byte signature; buffer is sized generously.
    return Buffer.from(this.pkcs11.C_Sign(this.session, data, Buffer.alloc(512)));
  }

  async listKeyLabels(): Promise<string[]> {
    this.ensureOpen();
    const p = this.pkcs11;
    p.C_FindObjectsInit(this.session, [{ type: p.CKA_CLASS, value: p.CKO_PUBLIC_KEY }]);
    const labels: string[] = [];
    for (;;) {
      const handle = p.C_FindObjects(this.session);
      if (!handle) break;
      const attrs = p.C_GetAttributeValue(this.session, handle, [{ type: p.CKA_LABEL }]);
      labels.push(Buffer.from(attrs[0].value).toString('utf8'));
    }
    p.C_FindObjectsFinal(this.session);
    return labels;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    try { this.pkcs11.C_Logout(this.session); } catch { /* may not be logged in */ }
    try { this.pkcs11.C_CloseSession(this.session); } catch { /* ignore */ }
    try { this.pkcs11.C_Finalize(); } catch { /* ignore */ }
    this.opened = false;
  }
}

// ─── In-memory emulator (tests) ──────────────────────────────────────────────

interface EmulatedKey {
  privateKeyPem: string;
  modulus: Buffer;
  exponent: Buffer;
}

/**
 * Faithful in-memory PKCS#11 emulator for tests. Emulates the operations the
 * signer uses (CKM_SHA256_RSA_PKCS via Node RSA-SHA256), so the signer's real
 * code path is exercised without the native binding or an HSM.
 */
export class InMemoryPkcs11Provider implements Pkcs11Provider {
  private keys = new Map<string, EmulatedKey>();
  private opened = false;
  private expectedPin?: string;
  /** Emulate a module that returns CKA_MODULUS DER-padded with a leading 0x00. */
  private derPadModulus = false;

  /** Simulate a vendor HSM that returns modulus/exponent with a leading 0x00. */
  simulateDerPaddedModulus(): void {
    this.derPadModulus = true;
  }

  /** Provision a key pair under a label (as `softhsm2-util --init-token` + keygen would). */
  addKey(label: string): void {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as { n: string; e: string };
    this.keys.set(label, {
      privateKeyPem: privateKey,
      modulus: Buffer.from(jwk.n, 'base64url'),
      exponent: Buffer.from(jwk.e, 'base64url'),
    });
  }

  /** Set the PIN the emulated token requires at login. */
  setPin(pin: string): void {
    this.expectedPin = pin;
  }

  async open(config: Pkcs11OpenConfig): Promise<void> {
    if (this.expectedPin !== undefined && config.pin !== this.expectedPin) {
      throw new Error('PKCS#11 (emulated): CKR_PIN_INCORRECT');
    }
    this.opened = true;
  }

  private ensureOpen(): void {
    if (!this.opened) throw new Error('PKCS#11 provider not open');
  }

  async findPrivateKeyHandle(label: string): Promise<Pkcs11KeyHandle | null> {
    this.ensureOpen();
    return this.keys.has(label) ? { label } : null;
  }

  async findPublicKey(label: string): Promise<Pkcs11PublicKey | null> {
    this.ensureOpen();
    const k = this.keys.get(label);
    if (!k) return null;
    if (this.derPadModulus) {
      return {
        modulus: Buffer.concat([Buffer.from([0x00]), k.modulus]),
        exponent: Buffer.concat([Buffer.from([0x00]), k.exponent]),
      };
    }
    return { modulus: k.modulus, exponent: k.exponent };
  }

  async sign(handle: Pkcs11KeyHandle, data: Buffer): Promise<Buffer> {
    this.ensureOpen();
    const label = (handle as { label: string }).label;
    const k = this.keys.get(label);
    if (!k) throw new Error(`PKCS#11 (emulated): key handle not found`);
    // CKM_SHA256_RSA_PKCS ≡ RSA-SHA256 hash-then-sign.
    return createSign('RSA-SHA256').update(data).sign(k.privateKeyPem);
  }

  async listKeyLabels(): Promise<string[]> {
    this.ensureOpen();
    return Array.from(this.keys.keys());
  }

  async close(): Promise<void> {
    this.opened = false;
  }
}
