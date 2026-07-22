/**
 * HSM signing path verification (issues #445, #482).
 *
 * The software signer has a real round-trip suite. The PKCS#11 signer (#482) is
 * now implemented and exercised end-to-end through an in-memory PKCS#11 emulator
 * (session/login/find-key/sign/extract). Real-hardware validation against
 * SoftHSMv2 runs in CI (.github/workflows/hsm-pkcs11.yml).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SoftwareSigner,
  PKCS11Signer,
  HSMSignerFactory,
  MerkleRootSigner,
  type HSMConfig,
} from '../hsm';
import { InMemoryPkcs11Provider } from '../pkcs11-provider';

let keyDir: string;

beforeAll(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'hsm-test-'));
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

function softwareConfig(): HSMConfig {
  return { mode: 'software', algorithm: 'RS256', keyPath: keyDir };
}

describe('SoftwareSigner round-trip (#445)', () => {
  it('generates a default key, signs, and verifies a merkle root', async () => {
    const signer = new SoftwareSigner(softwareConfig());
    await signer.initialize();

    const root = 'a'.repeat(64);
    const result = await signer.sign(root);

    expect(result.signature).toMatch(/^[0-9a-f]+$/);
    expect(result.algorithm).toBe('RS256');
    expect(result.keyId).toBe('default');
    expect(result.merkleRoot).toBe(root);

    const verification = await signer.verify(root, result);
    expect(verification.valid).toBe(true);
    await signer.cleanup();
  });

  it('rejects a tampered merkle root and a tampered signature', async () => {
    const signer = new SoftwareSigner(softwareConfig());
    await signer.initialize();

    const root = 'b'.repeat(64);
    const result = await signer.sign(root);

    const tamperedRoot = await signer.verify('c'.repeat(64), result);
    expect(tamperedRoot.valid).toBe(false);

    const tamperedSig = await signer.verify(root, {
      ...result,
      signature: result.signature.replace(/^../, 'ff'),
    });
    expect(tamperedSig.valid).toBe(false);
    await signer.cleanup();
  });

  it('persists keys to disk and reloads them across instances', async () => {
    const first = new SoftwareSigner(softwareConfig());
    await first.initialize();
    const root = 'd'.repeat(64);
    const signed = await first.sign(root);
    const publicKey = await first.getPublicKey();
    await first.cleanup();

    // Same keyPath → the reloaded default key must verify the old signature
    const second = new SoftwareSigner(softwareConfig());
    await second.initialize();
    expect(await second.getPublicKey()).toBe(publicKey);
    const verification = await second.verify(root, signed);
    expect(verification.valid).toBe(true);
    await second.cleanup();
  });

  it('throws on signing with an unknown key', async () => {
    const signer = new SoftwareSigner(softwareConfig());
    await signer.initialize();
    await expect(signer.sign('e'.repeat(64), 'nope')).rejects.toThrow(/Key not found/);
    await signer.cleanup();
  });

  it('works through the MerkleRootSigner facade', async () => {
    const facade = new MerkleRootSigner(softwareConfig());
    const root = 'f'.repeat(64);
    const signed = await facade.signMerkleRoot(root);
    const verification = await facade.verifyMerkleRootSignature(root, signed);
    expect(verification.valid).toBe(true);
    expect((await facade.listKeys()).length).toBeGreaterThan(0);
    await facade.cleanup();
  });
});

describe('PKCS#11 signer (#482) — via in-memory PKCS#11 emulator', () => {
  function pkcs11Config(): HSMConfig {
    return {
      mode: 'pkcs11',
      algorithm: 'RS256',
      pkcs11Library: '/emulated/libsofthsm2.so',
      slot: 0,
      pin: '1234',
      keyId: 'anchor-key',
    };
  }

  function provisionedEmulator(): InMemoryPkcs11Provider {
    const emu = new InMemoryPkcs11Provider();
    emu.setPin('1234');
    emu.addKey('anchor-key');
    return emu;
  }

  it('signs a merkle root inside the token and verifies with the extracted public key', async () => {
    const signer = new PKCS11Signer(pkcs11Config(), provisionedEmulator());
    await signer.initialize();

    const root = 'a'.repeat(64);
    const result = await signer.sign(root);
    expect(result.signature).toMatch(/^[0-9a-f]+$/);
    expect(result.keyId).toBe('anchor-key');
    expect(result.merkleRoot).toBe(root);

    const verification = await signer.verify(root, result);
    expect(verification.valid).toBe(true);
    await signer.cleanup();
  });

  it('rejects a tampered root and a tampered signature', async () => {
    const signer = new PKCS11Signer(pkcs11Config(), provisionedEmulator());
    await signer.initialize();
    const root = 'b'.repeat(64);
    const result = await signer.sign(root);

    expect((await signer.verify('c'.repeat(64), result)).valid).toBe(false);
    expect((await signer.verify(root, { ...result, signature: result.signature.replace(/^../, 'ff') })).valid).toBe(false);
    await signer.cleanup();
  });

  it('extracts an SPKI public key and lists keys', async () => {
    const emu = provisionedEmulator();
    emu.addKey('second-key');
    const signer = new PKCS11Signer(pkcs11Config(), emu);
    await signer.initialize();

    const pem = await signer.getPublicKey('anchor-key');
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);

    const keys = await signer.listKeys();
    expect(keys.map(k => k.keyId).sort()).toEqual(['anchor-key', 'second-key']);
    expect(keys.every(k => k.mode === 'pkcs11')).toBe(true);
    await signer.cleanup();
  });

  it('handles a DER-padded (leading 0x00) modulus from a vendor-style HSM', async () => {
    // Emulator normally returns minimal bytes; simulate a module that pads with
    // a leading zero. getPublicKey strips it to the canonical minimal JWK
    // encoding (RFC 7518); the signer round-trips either way — a regression
    // guard for the vendor-HSM padding case the minimal-bytes emulator misses.
    const emu = provisionedEmulator();
    emu.simulateDerPaddedModulus();
    const signer = new PKCS11Signer(pkcs11Config(), emu);
    await signer.initialize();
    const root = 'e'.repeat(64);
    const result = await signer.sign(root);
    expect((await signer.verify(root, result)).valid).toBe(true);
    expect(await signer.getPublicKey('anchor-key')).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    await signer.cleanup();
  });

  it('throws a clear error when the keyId is not on the token', async () => {
    const signer = new PKCS11Signer(pkcs11Config(), provisionedEmulator());
    await signer.initialize();
    await expect(signer.sign('root', 'no-such-key')).rejects.toThrow(/private key not found/);
    await signer.cleanup();
  });

  it('fails login on the wrong PIN', async () => {
    const emu = provisionedEmulator(); // expects '1234'
    const signer = new PKCS11Signer({ ...pkcs11Config(), pin: 'wrong' }, emu);
    await expect(signer.initialize()).rejects.toThrow(/PIN_INCORRECT/);
  });

  it('round-trips through the MerkleRootSigner facade with mode:pkcs11', async () => {
    const facade = new MerkleRootSigner(pkcs11Config(), { pkcs11Provider: provisionedEmulator() });
    const root = 'f'.repeat(64);
    const signed = await facade.signMerkleRoot(root);
    expect((await facade.verifyMerkleRootSignature(root, signed)).valid).toBe(true);
    await facade.cleanup();
  });

  it('signature is byte-compatible with software RSA-SHA256 verification (interop)', async () => {
    // A signature produced "in the token" must verify with a plain Node
    // createVerify against the extracted public key — proving CKM_SHA256_RSA_PKCS
    // interoperates with the relayer's verification.
    const { createVerify } = await import('crypto');
    const signer = new PKCS11Signer(pkcs11Config(), provisionedEmulator());
    await signer.initialize();
    const root = 'd'.repeat(64);
    const result = await signer.sign(root);
    const pem = await signer.getPublicKey('anchor-key');
    const v = createVerify('RSA-SHA256');
    v.update(root);
    v.end();
    expect(v.verify(pem, result.signature, 'hex')).toBe(true);
    await signer.cleanup();
  });

  it('factory routes modes correctly and rejects hardware mode', () => {
    expect(HSMSignerFactory.createSigner(softwareConfig())).toBeInstanceOf(SoftwareSigner);
    expect(
      HSMSignerFactory.createSigner({ mode: 'pkcs11', algorithm: 'RS256' })
    ).toBeInstanceOf(PKCS11Signer);
    expect(() =>
      HSMSignerFactory.createSigner({ mode: 'hardware', algorithm: 'RS256' })
    ).toThrow(/not implemented/);
  });
});
