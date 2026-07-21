# HSM / Merkle-Root Signing: Provider Matrix & Status

> Gate verification record for issue #445 (2026-07-21). The HSM/PKCS#11
> path was specified in #291–292, both closed in the 2026-02-15 bulk-close
> without verification. This document records what actually exists.

## Provider matrix

| Mode (`HSMConfig.mode`) | Status | Evidence |
|--------------------------|--------|----------|
| `software` | ✅ **Implemented & tested** | `SoftwareSigner` — Node crypto, RSA-2048, PKCS#8/SPKI PEM persisted under `keyPath` (default `.keys/`). Round-trip suite: `server/integrity/__tests__/hsm.test.ts` |
| `pkcs11` | ❌ **Stub — throws on every call** | `PKCS11Signer` (`server/integrity/hsm.ts:263-305`): `initialize`/`sign`/`verify`/`getPublicKey`/`listKeys` all raise `not yet implemented`. Implementation tracked in **#482** |
| `hardware` | ❌ Not implemented | Factory throws (`hsm.ts:319`) |

No PKCS#11 provider (SoftHSMv2 or vendor HSM) has ever been exercised
against this codebase. Any deployment configured with `mode: 'pkcs11'`
fails at startup.

## What actually runs in production paths

`server/integrity/resilience.ts` instantiates `MerkleRootSigner` for both
its **primary** and **fallback** signers from configuration. With the
PKCS#11 stub, the only viable configuration today is software/software —
i.e. the "HSM-backed" integrity pipeline is software-key signing with a
software-key fallback. Threat-model accordingly: the signing key lives as
a PEM file on the server filesystem.

## Test coverage (added by the #445 gate)

`server/integrity/__tests__/hsm.test.ts`:

- Software round-trip: key-gen → sign → verify
- Tamper detection (modified root, modified signature)
- Key persistence across signer instances (same `keyPath`)
- Unknown-key error path; `MerkleRootSigner` facade
- **PKCS#11 status pin** — asserts the stub throws `not yet implemented`.
  When #482 lands a real implementation this test fails on purpose:
  update this matrix and replace the pin with SoftHSMv2 round-trip tests.

## Planned CI verification (with #482)

- SoftHSMv2 as a GitHub Actions service container (ubuntu runner)
- Token init + RSA key-gen via `pkcs11-tool`, then a vitest suite running
  `MerkleRootSigner` with `mode: 'pkcs11'` against
  `/usr/lib/softhsm/libsofthsm2.so`
- Provider matrix updated with each provider actually validated
