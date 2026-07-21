/**
 * HSM signing path verification (issue #445).
 *
 * The software signer gets a real round-trip suite (it previously had zero
 * working coverage — the only references lived in the openssl-gated e2e
 * file whose tests are all skipped). The PKCS#11 signer is pinned as
 * not-implemented: if someone lands a real implementation, these tests
 * fail loudly and the provider matrix in docs/security/hsm-signing.md must
 * be updated (#482 tracks the implementation).
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

describe('PKCS#11 signer status pin (#445 → #482)', () => {
  it('is a stub: every operation throws not-implemented', async () => {
    const signer = new PKCS11Signer({
      mode: 'pkcs11',
      algorithm: 'RS256',
      pkcs11Library: '/usr/lib/softhsm/libsofthsm2.so',
      slot: 0,
      pin: '1234',
    });

    await expect(signer.initialize()).rejects.toThrow(/not yet implemented/);
    await expect(signer.sign('root')).rejects.toThrow(/not yet implemented/);
    await expect(signer.getPublicKey()).rejects.toThrow(/not yet implemented/);
    await expect(signer.listKeys()).rejects.toThrow(/not yet implemented/);
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
