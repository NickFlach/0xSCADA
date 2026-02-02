# ADR-0003: Clique PoA Consensus Selection

## Status

Accepted

## Date

2024-01-20

## Context

0xSCADA requires a blockchain consensus mechanism suitable for industrial SCADA environments. Requirements:

1. **Low latency**: Block times must support near-real-time operations
2. **Deterministic finality**: No probabilistic confirmation delays
3. **Energy efficiency**: Industrial sites have sustainability requirements
4. **Known validators**: Permissioned network with identified operators
5. **EVM compatibility**: Leverage existing Ethereum tooling

Public proof-of-work chains (Bitcoin, legacy Ethereum) are unsuitable due to:
- High energy consumption
- Slow block times (10+ minutes for Bitcoin)
- Probabilistic finality requiring multiple confirmations

## Decision

We adopt **Clique Proof-of-Authority (PoA)** consensus with the following configuration:

1. **Validator Set**:
   - Fixed set of authorized signers (facility operators, auditors)
   - Minimum 3 validators for fault tolerance
   - Validators identified by Ethereum addresses

2. **Block Parameters**:
   - Block time: 5 seconds (configurable down to 1 second)
   - Epoch length: 30000 blocks (~41 hours) for vote tallying
   - In-turn vs out-of-turn signing for availability

3. **Validator Management**:
   - Voting mechanism to add/remove validators
   - 51% majority required for changes
   - Changes take effect after epoch boundary

4. **Client Implementation**:
   - Geth-based private network
   - Standard EVM execution layer
   - JSON-RPC API compatibility

## Consequences

### Positive

- **Fast finality**: Single block confirmation sufficient
- **Low latency**: 5-second blocks, tunable lower
- **Energy efficient**: No mining, minimal compute
- **EVM compatible**: Full Solidity/tooling ecosystem
- **Simple operations**: Well-documented, battle-tested

### Negative

- **Centralization risk**: Small validator set
- **Validator collusion**: 51% attack by known parties
- **Not censorship-resistant**: Validators can exclude transactions
- **Trust assumptions**: Must trust validator operators

### Neutral

- Standard for enterprise Ethereum deployments
- Suitable for consortium/permissioned use cases
- Can migrate to other consensus if needed

## Alternatives Considered

### Alternative 1: IBFT/IBFT2 (Istanbul BFT)

Byzantine fault-tolerant consensus with immediate finality.

Rejected because: Higher message complexity, more validators required for security guarantees, and less ecosystem support than Clique.

### Alternative 2: QBFT (Quorum BFT)

ConsenSys Quorum's BFT implementation.

Rejected because: Adds dependency on Quorum stack; Clique provides sufficient guarantees for our trust model.

### Alternative 3: Tendermint/CometBFT

Cosmos SDK's BFT consensus.

Rejected because: Different execution model, would lose EVM compatibility and Ethereum tooling.

### Alternative 4: Proof of Stake (PoS)

Ethereum 2.0 style PoS consensus.

Rejected because: Requires staking economics, longer finality (~13 minutes for full finality), and more complex validator management.

## References

- [Clique PoA Specification (EIP-225)](https://eips.ethereum.org/EIPS/eip-225)
- [Geth Private Network Setup](https://geth.ethereum.org/docs/interface/private-network)
- [ADR-0001: Hybrid Architecture](ADR-0001-hybrid-on-off-chain-architecture.md)
