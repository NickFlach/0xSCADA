/**
 * Two-Factor Authentication (2FA) Service
 *
 * TOTP-based 2FA compatible with Google Authenticator, Authy, etc.
 * Issues: #24, #37
 */

import * as crypto from 'crypto';

/** TOTP configuration */
export interface TOTPConfig {
  /** Base32-encoded secret */
  secret: string;
  /** Account label (usually email) */
  label: string;
  /** Issuer name shown in authenticator app */
  issuer: string;
  /** Number of digits (default: 6) */
  digits?: number;
  /** Time step in seconds (default: 30) */
  period?: number;
  /** Hash algorithm (default: SHA1 for compatibility) */
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
}

/** 2FA setup result returned when enabling 2FA */
export interface TwoFactorSetupResult {
  /** Base32-encoded secret for manual entry */
  secret: string;
  /** otpauth:// URI for QR code generation */
  otpauthUrl: string;
  /** Backup codes for account recovery */
  backupCodes: string[];
}

/** 2FA verification result */
export interface TwoFactorVerifyResult {
  valid: boolean;
  /** If a backup code was used */
  usedBackupCode?: boolean;
}

// Base32 encoding alphabet (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generate a cryptographically secure random secret.
 */
export function generateSecret(length = 20): string {
  const buffer = crypto.randomBytes(length);
  return base32Encode(buffer);
}

/**
 * Base32 encode a buffer (RFC 4648).
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

/**
 * Base32 decode a string to a buffer.
 */
export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generate a TOTP code for a given time.
 */
export function generateTOTP(
  secret: string,
  options: {
    time?: number;
    period?: number;
    digits?: number;
    algorithm?: string;
  } = {}
): string {
  const {
    time = Math.floor(Date.now() / 1000),
    period = 30,
    digits = 6,
    algorithm = 'sha1',
  } = options;

  const counter = Math.floor(time / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(0, 0);
  counterBuffer.writeUInt32BE(counter, 4);

  const key = base32Decode(secret);
  const hmac = crypto.createHmac(algorithm, key);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return (code % Math.pow(10, digits)).toString().padStart(digits, '0');
}

/**
 * Verify a TOTP code with a time window tolerance.
 */
export function verifyTOTP(
  secret: string,
  token: string,
  options: {
    period?: number;
    digits?: number;
    algorithm?: string;
    /** Number of periods to check before/after current time (default: 1) */
    window?: number;
  } = {}
): boolean {
  const { period = 30, digits = 6, algorithm = 'sha1', window = 1 } = options;
  const now = Math.floor(Date.now() / 1000);

  for (let i = -window; i <= window; i++) {
    const time = now + i * period;
    const expected = generateTOTP(secret, { time, period, digits, algorithm });
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return true;
    }
  }

  return false;
}

/**
 * Generate an otpauth:// URI for QR code generation.
 */
export function generateOtpauthUrl(config: TOTPConfig): string {
  const {
    secret,
    label,
    issuer,
    digits = 6,
    period = 30,
    algorithm = 'SHA1',
  } = config;

  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm,
    digits: digits.toString(),
    period: period.toString(),
  });

  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  return `otpauth://totp/${encodedLabel}?${params.toString()}`;
}

/**
 * Generate backup codes for account recovery.
 */
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/**
 * Hash a backup code for storage (don't store plaintext).
 */
export function hashBackupCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code.replace(/-/g, '').toUpperCase())
    .digest('hex');
}

/**
 * Setup 2FA for a user — generates secret, otpauth URL, and backup codes.
 */
export function setup2FA(
  label: string,
  issuer = '0xSCADA'
): TwoFactorSetupResult {
  const secret = generateSecret();
  const otpauthUrl = generateOtpauthUrl({ secret, label, issuer });
  const backupCodes = generateBackupCodes();

  return { secret, otpauthUrl, backupCodes };
}

/**
 * Verify a 2FA token (TOTP or backup code).
 */
export function verify2FA(
  secret: string,
  token: string,
  hashedBackupCodes: string[] = []
): TwoFactorVerifyResult {
  // Try TOTP first
  if (/^\d{6}$/.test(token)) {
    if (verifyTOTP(secret, token)) {
      return { valid: true };
    }
  }

  // Try backup code
  const hashedToken = hashBackupCode(token);
  if (hashedBackupCodes.includes(hashedToken)) {
    return { valid: true, usedBackupCode: true };
  }

  return { valid: false };
}

/**
 * Express-style middleware that requires 2FA verification.
 */
export function require2FAMiddleware() {
  return (req: any, res: any, next: any) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (user.twoFactorEnabled && !user.twoFactorVerified) {
      return res.status(403).json({
        error: '2FA verification required',
        code: '2FA_REQUIRED',
      });
    }

    next();
  };
}
