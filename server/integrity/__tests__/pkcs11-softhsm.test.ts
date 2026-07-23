/**
 * Real-hardware PKCS#11 validation against SoftHSMv2 (#482).
 *
 * This exercises the PRODUCTION path — PKCS11Signer with the default
 * Pkcs11jsProvider (native `pkcs11js`) against a live SoftHSMv2 token — which
 * the emulator-based tests in hsm.test.ts cannot cover. It runs ONLY in CI,
 * where the workflow (.github/workflows/hsm-pkcs11.yml) installs SoftHSMv2 +
 * pkcs11js and provisions a token; it is skipped everywhere else.
 *
 * Env (set by the CI workflow):
 *   PKCS11_SOFTHSM=1        enable this suite
 *   SOFTHSM_LIB=<path>      path to libsofthsm2.so
 *   SOFTHSM_PIN=<pin>       user PIN of the provisioned token
 *   SOFTHSM_KEY_LABEL=<l>   CKA_LABEL of the provisioned RSA key pair
 */
import { describe, it, expect } from 'vitest';
import { createVerify } from 'crypto';
import { PKCS11Signer, MerkleRootSigner, type HSMConfig } from '../hsm';

const enabled = process.env.PKCS11_SOFTHSM === '1';

function softhsmConfig(): HSMConfig {
  return {
    mode: 'pkcs11',
    algorithm: 'RS256',
    pkcs11Library: process.env.SOFTHSM_LIB || '/usr/lib/softhsm/libsofthsm2.so',
    slot: 0,
    pin: process.env.SOFTHSM_PIN || '1234',
    keyId: process.env.SOFTHSM_KEY_LABEL || 'anchor-key',
  };
}

describe.skipIf(!enabled)('PKCS#11 signer against real SoftHSMv2 (#482, CI only)', () => {
  it('key-gen → sign → verify round-trip through the token', async () => {
    const signer = new PKCS11Signer(softhsmConfig());
    await signer.initialize();
    try {
      const root = '0x' + 'ab'.repeat(32);
      const result = await signer.sign(root);
      expect(result.signature).toMatch(/^[0-9a-f]+$/);

      // Verify via the signer (extracts the public key from the token)…
      expect((await signer.verify(root, result)).valid).toBe(true);
      // …and independently with Node RSA-SHA256 against the extracted SPKI key,
      // proving CKM_SHA256_RSA_PKCS interoperates with the relayer's check.
      const pem = await signer.getPublicKey();
      const v = createVerify('RSA-SHA256');
      v.update(root);
      v.end();
      expect(v.verify(pem, result.signature, 'hex')).toBe(true);

      expect((await signer.listKeys()).length).toBeGreaterThan(0);
    } finally {
      await signer.cleanup();
    }
  });

  it('round-trips through the MerkleRootSigner facade with mode:pkcs11', async () => {
    const facade = new MerkleRootSigner(softhsmConfig());
    try {
      const root = '0x' + 'cd'.repeat(32);
      const signed = await facade.signMerkleRoot(root);
      expect((await facade.verifyMerkleRootSignature(root, signed)).valid).toBe(true);
    } finally {
      await facade.cleanup();
    }
  });
});
