# HSM Integration — Kernel Crypto Subsystem

> Issue #151 — Expose HSM operations to kernel crypto subsystem

## Overview

Hardware Security Module integration for the 0xSCADA kernel. Keys are generated and used inside the HSM — private key material never enters system memory. A software fallback enables development without hardware.

## Provider Hierarchy

1. **PKCS#11 Hardware HSM** — Production (Thales Luna, Entrust nShield, YubiHSM)
2. **Cloud KMS** — AWS CloudHSM, Azure Key Vault, GCP Cloud KMS
3. **Software Fallback** — Node.js crypto (development only)

The `KernelHSMBridge` automatically falls back if the primary provider fails.

## Supported Operations

| Operation | Algorithms | Description |
|-----------|-----------|-------------|
| Key Generation | RSA-2048/4096, ECDSA P-256/secp256k1, Ed25519 | Generate key pairs inside HSM |
| Sign | SHA-256/384/512, Keccak-256 | Digital signatures for event anchoring |
| Verify | Same as sign | Verify signatures on imported state roots |
| Encrypt/Decrypt | AES-256-GCM | Encrypt sensitive SCADA telemetry |
| Key Rotation | All algorithms | Generate new key, deactivate old |
| Audit | — | Full audit trail of all operations |

## Key Lifecycle

```
pre-active → active → deactivated → destroyed
                 │
                 └─→ compromised → destroyed
```

- **pre-active:** Generated but not yet approved for use
- **active:** In use for signing/encryption
- **deactivated:** Rotated out; still available for verification of old signatures
- **compromised:** Emergency revocation
- **destroyed:** Cryptographic erasure; unrecoverable

## Usage

```typescript
import { KernelHSMBridge } from "../server/kernel/hsm-interface";

const hsm = new KernelHSMBridge();
await hsm.initialize({ type: "software" });

const pair = await hsm.generateKeyPair("ecdsa-secp256k1", "event-signer", ["sign", "verify"]);
const sig = await hsm.sign({ keyId: pair.publicKey.id, data: eventHash, algorithm: "sha256" });
const ok = await hsm.verify({ keyId: pair.publicKey.id, data: eventHash, signature: sig.signature, algorithm: "sha256" });
```

## Security Notes

- Software fallback logs a warning on initialization — never use in production
- All operations are audit-logged with timestamps and key IDs
- Key rotation policy supports automatic rotation with configurable intervals
- Keccak-256 signing enables Ethereum-compatible signatures for L2 anchoring
