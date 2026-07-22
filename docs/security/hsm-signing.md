# HSM / Merkle-Root Signing: Provider Matrix & Status

> Originally the #445 gate record (2026-07-21); updated for #482 when the
> PKCS#11 signer was implemented and validated.

## Provider matrix

| Mode (`HSMConfig.mode`) | Status | Evidence |
|--------------------------|--------|----------|
| `software` | ✅ **Implemented & tested** | `SoftwareSigner` — Node crypto, RSA-2048, PKCS#8/SPKI PEM persisted under `keyPath` (default `.keys/`). Round-trip suite: `server/integrity/__tests__/hsm.test.ts` |
| `pkcs11` | ✅ **Implemented & tested** | `PKCS11Signer` (`server/integrity/hsm.ts`) signs via CKM_SHA256_RSA_PKCS through an injectable `Pkcs11Provider`. Logic tested end-to-end against an in-memory PKCS#11 emulator (`hsm.test.ts`); **SoftHSMv2 verified in CI** (`.github/workflows/hsm-pkcs11.yml` + `pkcs11-softhsm.test.ts`) |
| `hardware` | ❌ Not implemented | Factory throws |

## PKCS#11 provider matrix (validated)

| Provider | Validated | How |
|----------|-----------|-----|
| SoftHSMv2 | ✅ | CI job `HSM PKCS#11 (SoftHSMv2)` — token init → RSA-2048 keygen → sign → verify, plus a Node RSA-SHA256 interop check against the extracted public key |
| Vendor HSMs (Thales / AWS CloudHSM / etc.) | ⬜ not yet | Any PKCS#11 module exposing RSA + CKM_SHA256_RSA_PKCS should work; validate per provider and add a row |

## How it works

- `PKCS11Signer` talks to the token through a `Pkcs11Provider` (session,
  login, find-key, sign, extract-public-key). The production provider is
  `Pkcs11jsProvider`, backed by the native `pkcs11js` binding; tests use an
  in-memory emulator that emulates the same operations with Node RSA.
- The private key **never leaves the token**. The signer extracts only the
  public key (SPKI PEM, built from the RSA modulus/exponent via JWK) for
  verification. Because CKM_SHA256_RSA_PKCS is hash-then-sign RSA-SHA256,
  signatures are byte-compatible with the software signer and the relayer's
  Node `createVerify('RSA-SHA256')` check.
- `resilience.ts` can run **primary `pkcs11` + fallback `software`**: if the
  token fails to initialize (e.g. wrong PIN, module missing), it degrades to
  the software signer. Both paths are exercised in
  `server/integrity/__tests__/resilience-anchor.test.ts`.

## Deployment

- `pkcs11js` is an **optional** native dependency — install it in production
  (`npm install pkcs11js`) and configure:
  - `HSMConfig.pkcs11Library` — module path (e.g. `/usr/lib/softhsm/libsofthsm2.so`)
  - `HSMConfig.slot` — slot index (default 0)
  - `HSMConfig.pin` — user PIN
  - `HSMConfig.keyId` — the key's CKA_LABEL
- Absent the binding, `PKCS11Signer.initialize()` throws a clear
  "install pkcs11js" error rather than failing silently.
- The L2 anchor pipeline (`AnchorPipeline`, #489) uses a software signer by
  default; point it at a token by passing an HSM config with `mode: 'pkcs11'`.

## Test coverage

`server/integrity/__tests__/hsm.test.ts`:
- Software round-trip, tamper detection, key persistence, unknown-key error,
  `MerkleRootSigner` facade.
- **PKCS#11 (emulator)**: sign-in-token → verify-with-extracted-key round-trip,
  tampered-root/tampered-signature rejection, SPKI extraction + key listing,
  key-not-found error, wrong-PIN login failure, facade round-trip, and RSA-SHA256
  interop.

`server/integrity/__tests__/pkcs11-softhsm.test.ts` (CI only, gated on
`PKCS11_SOFTHSM=1`): the same round-trip against a **real SoftHSMv2** token via
`pkcs11js`.

`server/integrity/__tests__/resilience-anchor.test.ts`: primary `pkcs11`
signing, and software fallback when the token init fails.
