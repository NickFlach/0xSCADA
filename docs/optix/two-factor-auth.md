# Two-Factor Authentication (2FA)

## Overview

0xSCADA supports TOTP-based two-factor authentication compatible with Google Authenticator, Authy, Microsoft Authenticator, and other standard TOTP apps.

## Architecture

- **`server/auth/two-factor.ts`** — TOTP generation/verification, QR setup, backup codes
- **`server/auth/rbac.ts`** — Integration with RBAC middleware for 2FA-required routes

## Setup Flow

1. User requests 2FA setup → server generates secret + otpauth URL
2. Client renders QR code from the otpauth URL
3. User scans QR code with authenticator app
4. User enters verification code to confirm setup
5. Server stores hashed backup codes for recovery

```typescript
import { setup2FA, verify2FA, hashBackupCode } from './server/auth/two-factor';

// 1. Generate setup data
const setup = setup2FA('user@company.com', '0xSCADA');
// setup.secret     → Base32 secret for manual entry
// setup.otpauthUrl  → For QR code generation
// setup.backupCodes → 10 recovery codes

// 2. Store hashed backup codes (never store plaintext)
const hashedCodes = setup.backupCodes.map(hashBackupCode);

// 3. Verify user's first code to confirm setup
const result = verify2FA(setup.secret, userEnteredCode, hashedCodes);
if (result.valid) {
  // Enable 2FA for user
}
```

## Verification

```typescript
import { verifyTOTP } from './server/auth/two-factor';

// Verify a 6-digit TOTP code (±1 time window tolerance)
const valid = verifyTOTP(userSecret, submittedCode);
```

## Backup Codes

- 10 single-use recovery codes generated during setup
- Format: `XXXX-XXXX` (hex)
- Stored as SHA-256 hashes
- Each code can only be used once (remove from stored hashes after use)

## Middleware Integration

```typescript
import { require2FAMiddleware } from './server/auth/two-factor';
import { requirePermissions } from './server/auth/rbac';
import { Permission } from '../../shared/types/rbac';

// Require 2FA for sensitive operations
app.post('/api/recipes/:id/approve',
  requirePermissions([Permission.RECIPE_APPROVE], { require2FA: true }),
  approveHandler
);

// Or use standalone 2FA middleware
app.use('/api/admin', require2FAMiddleware());
```

## Security Considerations

- Secrets are generated using `crypto.randomBytes` (CSPRNG)
- TOTP verification uses `crypto.timingSafeEqual` to prevent timing attacks
- Time window tolerance of ±1 period (±30 seconds) to account for clock drift
- Backup codes are hashed before storage
