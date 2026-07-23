# Changelog

Notable changes to the 0xSCADA contracts and platform.

## Unreleased

### Changed (on-chain state shape)

- **`BountyPayment.Payment` struct: removed the `txHash` field** (#448).
  It was documented as "transaction hash for reference" but actually stored
  `blockhash(block.number - 1)` — the previous block's hash, which identifies
  nothing about the payment. A transaction cannot know its own hash on-chain;
  consumers needing the real payment tx hash should take it from the
  `BountyPaid` event log. No deployed instances existed (the contract did not
  compile before #449's fix), so no live-state migration is required.

### Fixed

- **`BountyPayment` payout functions now follow strict
  checks-effects-interactions** (#449): status, payment record, and
  `totalPaidOut` are finalized before any external transfer, in both
  `payBounty` and `payBountyMultiple`. Latent compile error in
  `payBountyMultiple` fixed (invalid `address payable[]` → `address[]`
  assignment).
