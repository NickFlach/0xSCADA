# Multi-site federation

This document is the executable companion to
[ADR-0014](../decisions/ADR-0014-production-scale-architecture.md) for issue
[#223](https://github.com/NickFlach/0xSCADA/issues/223).

`server/scaling/federation.ts` supplies the application-level federation
contracts without coupling them to a particular registry or network client:

- `FederatedSiteDiscovery` combines registry and mDNS adapters, deduplicates
  results, and applies `MutualTlsSiteIdentityPolicy` before returning peers.
- `CrossSiteTagReference` parses and emits canonical `site:area/tag`
  references.
- `FederatedAlarmView` and `FederatedReporting` query sites concurrently and
  return both data and explicit failures, so an unavailable site never produces
  a complete-looking partial view.
- `ReplicatedConfiguration` is a Lamport-clocked last-writer-wins map with
  retained tombstones, deterministic actor tie-breaking, and conflict
  visibility. Merge is associative, commutative, and idempotent.

The discovery identity policy fails closed unless the endpoint uses HTTPS, the
certificate is currently valid, the issuer is trusted, the claimed site matches
the certificate identity, the SAN contains `urn:0xscada:site:<site-id>`, and
any configured certificate pin matches. Conflicting certificates advertised
for one site namespace reject that namespace for the discovery pass.

Discovery adapters receive an `AbortSignal`. Production registry and mDNS
bindings must return certificate identity observed by the authenticated mTLS
transport, not metadata supplied only by an unauthenticated advertisement.

## Verification

Run:

```bash
npx vitest run server/scaling/__tests__/federation.test.ts
npm run typecheck
npm run build
```

The focused suite covers registry/mDNS deduplication, mTLS rejection,
conflicting identities, cross-site references, partial alarm/report failures,
and CRDT convergence, conflict, and tombstone behavior.
