# mTLS Certificate Management Guide

## Overview

0xSCADA uses mutual TLS (mTLS) for inter-service communication. The `MTLSManager` handles certificate generation, rotation, validation, and revocation.

## Architecture

```
Service A ──[mTLS]──> Service B
    │                     │
    └── Client Cert ──────┘
         + CA Cert
```

Every service holds its own key pair + a shared CA certificate. Both sides verify the other's certificate.

## Usage

```typescript
import { MTLSManager } from '../server/security/mtls-manager';

const manager = new MTLSManager({
  rejectUnauthorized: true,
  rotationPolicy: { maxAgeDays: 90, renewBeforeDays: 14, autoRotate: true },
});

// Generate CA (dev only — use Vault PKI in production)
manager.generateCA();

// Issue service certificates
manager.issueCertificate('gateway');
manager.issueCertificate('historian');

// Get TLS options for an HTTPS connection
const opts = manager.getConnectionOptions('gateway');
// → { cert, key, ca, rejectUnauthorized, requestCert }

// Start auto-rotation
manager.startAutoRotation();
```

## Certificate Rotation

Certificates are rotated automatically when `autoRotate: true`. The manager checks hourly and renews any certificate expiring within `renewBeforeDays`.

Manual rotation:
```typescript
manager.rotateCertificate('gateway');
```

## Validation

```typescript
const result = manager.validateCertificate('gateway');
// → { valid: true } or { valid: false, reason: 'Certificate expired' }
```

## Production Recommendations

1. **Use HashiCorp Vault PKI** instead of self-signed CA
2. **Store private keys in HSM** or secure key store
3. **Set `maxAgeDays: 30`** for short-lived certificates
4. **Monitor** `getCertificatesNearingExpiry()` in your alerting system
5. **Revoke** compromised certificates immediately
