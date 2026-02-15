import { generateSecret, generateTOTP, verifyTOTP, setup2FA, verify2FA, hashBackupCode, base32Encode, base32Decode, generateOtpauthUrl } from '../two-factor';

describe('Two-Factor Authentication', () => {
  it('should generate a base32 secret', () => {
    const secret = generateSecret();
    expect(secret).toBeDefined();
    expect(secret.length).toBeGreaterThan(0);
    expect(/^[A-Z2-7]+$/.test(secret)).toBe(true);
  });

  it('should encode and decode base32', () => {
    const original = Buffer.from('Hello, World!');
    const encoded = base32Encode(original);
    const decoded = base32Decode(encoded);
    expect(decoded.toString()).toBe('Hello, World!');
  });

  it('should generate valid TOTP codes', () => {
    const secret = generateSecret();
    const code = generateTOTP(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('should verify valid TOTP codes', () => {
    const secret = generateSecret();
    const code = generateTOTP(secret);
    expect(verifyTOTP(secret, code)).toBe(true);
  });

  it('should reject invalid TOTP codes', () => {
    const secret = generateSecret();
    expect(verifyTOTP(secret, '000000')).toBe(false);
  });

  it('should setup 2FA with secret, URL, and backup codes', () => {
    const result = setup2FA('user@example.com');
    expect(result.secret).toBeDefined();
    expect(result.otpauthUrl).toContain('otpauth://totp/');
    expect(result.otpauthUrl).toContain('0xSCADA');
    expect(result.backupCodes).toHaveLength(10);
  });

  it('should generate valid otpauth URL', () => {
    const url = generateOtpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', label: 'user@test.com', issuer: '0xSCADA' });
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=0xSCADA');
  });

  it('should verify with backup codes', () => {
    const secret = generateSecret();
    const backupCode = 'ABCD-1234';
    const hashed = hashBackupCode(backupCode);

    const result = verify2FA(secret, backupCode, [hashed]);
    expect(result.valid).toBe(true);
    expect(result.usedBackupCode).toBe(true);
  });

  it('should reject invalid backup codes', () => {
    const secret = generateSecret();
    const result = verify2FA(secret, 'XXXX-XXXX', []);
    expect(result.valid).toBe(false);
  });
});
