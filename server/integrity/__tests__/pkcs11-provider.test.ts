import { describe, expect, it } from 'vitest';
import { Pkcs11jsProvider } from '../pkcs11-provider';

describe('Pkcs11jsProvider native adapter (#581)', () => {
  it('takes PKCS#11 constants from the module export, not the native instance', async () => {
    const constants = {
      CKF_SERIAL_SESSION: 0x01,
      CKF_RW_SESSION: 0x02,
      CKU_USER: 0x03,
      CKA_CLASS: 0x10,
      CKA_LABEL: 0x11,
      CKA_MODULUS: 0x12,
      CKA_PUBLIC_EXPONENT: 0x13,
      CKO_PRIVATE_KEY: 0x20,
      CKO_PUBLIC_KEY: 0x21,
      CKM_SHA256_RSA_PKCS: 0x30,
      CKM_SHA384_RSA_PKCS: 0x31,
      CKM_SHA512_RSA_PKCS: 0x32,
    };
    const calls = {
      openFlags: 0,
      userType: 0,
      findTemplates: [] as Array<Array<{ type: number; value?: unknown }>>,
      attributeTemplates: [] as Array<Array<{ type: number }>>,
      mechanisms: [] as number[],
    };
    const handle = Buffer.from([0x01]);

    class FakeNativePkcs11 {
      private findReturned = false;

      load(): void {}
      C_Initialize(): void {}
      C_GetSlotList(): Buffer[] { return [Buffer.from([0x00])]; }
      C_OpenSession(_slot: Buffer, flags: number): Buffer {
        calls.openFlags = flags;
        return Buffer.from([0x02]);
      }
      C_Login(_session: Buffer, userType: number): void {
        calls.userType = userType;
      }
      C_FindObjectsInit(
        _session: Buffer,
        template: Array<{ type: number; value?: unknown }>,
      ): void {
        calls.findTemplates.push(template);
        this.findReturned = false;
      }
      C_FindObjects(): Buffer | null {
        if (this.findReturned) return null;
        this.findReturned = true;
        return handle;
      }
      C_FindObjectsFinal(): void {}
      C_GetAttributeValue(
        _session: Buffer,
        _handle: Buffer,
        template: Array<{ type: number }>,
      ): Array<{ type: number; value: Buffer }> {
        calls.attributeTemplates.push(template);
        return template.map(({ type }) => ({
          type,
          value: type === constants.CKA_LABEL
            ? Buffer.from('anchor-key')
            : Buffer.from([0x01]),
        }));
      }
      C_SignInit(_session: Buffer, mechanism: { mechanism: number }): void {
        calls.mechanisms.push(mechanism.mechanism);
      }
      C_Sign(): Buffer { return Buffer.from([0xaa]); }
      C_Logout(): void {}
      C_CloseSession(): void {}
      C_Finalize(): void {}
    }

    const moduleApi = { PKCS11: FakeNativePkcs11, ...constants };
    const provider = new Pkcs11jsProvider(() => moduleApi);
    await provider.open({ library: '/fake/libpkcs11.so', slot: 0, pin: '1234' });

    const privateKey = await provider.findPrivateKeyHandle('anchor-key');
    expect(privateKey).toBe(handle);
    await provider.findPublicKey('anchor-key');
    await provider.listKeyLabels();
    await provider.sign(privateKey, Buffer.from('root'), 'RSA-SHA256');
    await provider.close();

    expect(calls.openFlags).toBe(constants.CKF_SERIAL_SESSION | constants.CKF_RW_SESSION);
    expect(calls.userType).toBe(constants.CKU_USER);
    expect(calls.findTemplates).toEqual([
      [
        { type: constants.CKA_CLASS, value: constants.CKO_PRIVATE_KEY },
        { type: constants.CKA_LABEL, value: 'anchor-key' },
      ],
      [
        { type: constants.CKA_CLASS, value: constants.CKO_PUBLIC_KEY },
        { type: constants.CKA_LABEL, value: 'anchor-key' },
      ],
      [{ type: constants.CKA_CLASS, value: constants.CKO_PUBLIC_KEY }],
    ]);
    expect(calls.attributeTemplates).toEqual([
      [{ type: constants.CKA_MODULUS }, { type: constants.CKA_PUBLIC_EXPONENT }],
      [{ type: constants.CKA_LABEL }],
    ]);
    expect(calls.mechanisms).toEqual([constants.CKM_SHA256_RSA_PKCS]);
  });
});
