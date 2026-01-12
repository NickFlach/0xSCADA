# zkVM Runtime Trust Assumptions

This document describes the trust assumptions and security model for running the Keeper (stateless Ethereum block validator) inside a Zero-Knowledge Virtual Machine (zkVM).

## Overview

The Keeper is designed to validate Ethereum blocks statelessly, meaning it can verify block execution without access to the full blockchain state. When running inside a zkVM (like Ziren), the execution produces a cryptographic proof that the validation was performed correctly.

## Trust Model

### What We Trust

1. **zkVM Correctness**
   - The zkVM implementation correctly executes MIPS instructions
   - The zkVM's proof system is cryptographically sound
   - The zkVM runtime provides accurate system calls

2. **Cryptographic Primitives**
   - Keccak256 hash function implementation is correct
   - ECDSA signature verification is correct
   - The zkVM's accelerated crypto primitives match standard implementations

3. **Input Integrity**
   - The RLP-encoded payload (block + witness) is provided honestly by the prover
   - The prover cannot manipulate the payload without invalidating the proof

4. **Ethereum Protocol Rules**
   - The EVM implementation correctly follows the Ethereum specification
   - State transition rules are accurately implemented
   - Gas accounting is correct

### What We Verify (Trustlessly)

1. **Block Validity**
   - Transaction signatures are valid
   - State root matches after executing all transactions
   - Receipt root matches the computed receipts
   - Block header fields are consistent

2. **Execution Correctness**
   - Each transaction executes correctly against the witness state
   - State changes are applied properly
   - No state is accessed outside the provided witness

3. **Proof of Execution**
   - The zkVM proof demonstrates the execution happened as claimed
   - The proof cannot be forged without actually running the computation

### What We Do NOT Trust

1. **The Prover**
   - The prover may try to provide malicious inputs
   - The prover may try to prove invalid state transitions
   - Input validation is critical

2. **External Data Sources**
   - Chain configurations are embedded at compile time
   - No network calls are made during proof generation
   - All required data must be in the witness

## Security Properties

### Soundness
If the Keeper accepts a block (exits 0), then:
- The block is valid according to Ethereum consensus rules
- All transactions executed correctly
- The state root and receipt root match the block header

### Completeness
If a block is valid, the Keeper will accept it (assuming correct witness).

### Zero-Knowledge (depending on zkVM)
The proof reveals only:
- The block was valid
- The final state/receipt roots
It does NOT reveal:
- Transaction details (in ZK mode)
- Account balances
- Contract state

## zkVM-Specific Considerations

### Ziren Runtime (`//go:build ziren`)

When built with the `ziren` tag:

1. **Keccak256 System Call**
   - Uses `zkvm_runtime.Keccak256()` instead of software implementation
   - This is a precompile that generates ZK-friendly hash proofs
   - The hash is computed natively by the zkVM for efficiency

2. **Memory Model**
   - MIPS little-endian (mipsle) architecture
   - Soft-float for floating point (not used in Ethereum)
   - Garbage collection disabled for determinism

3. **Input Retrieval**
   - `getInput()` reads from zkVM-specific input mechanism
   - Input is committed to in the proof's public inputs

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Block validated successfully |
| 10 | Stateless execution failed |
| 11 | State root mismatch |
| 12 | Receipt root mismatch |
| 13 | Unknown chain ID |

## Attack Vectors & Mitigations

### 1. Malformed RLP Input
**Attack**: Provide truncated or malformed RLP data to cause panics.
**Mitigation**: Input validation with bounds checking before decoding.

### 2. Unknown Chain ID
**Attack**: Provide an unsupported chain ID to bypass validation.
**Mitigation**: Explicit chain ID whitelist; reject unknown chains.

### 3. Witness Manipulation
**Attack**: Provide a witness that doesn't match the actual chain state.
**Mitigation**: The computed state root will not match the block header.

### 4. Transaction Replay
**Attack**: Include transactions from a different block.
**Mitigation**: Transactions are validated against the block's context.

### 5. Resource Exhaustion
**Attack**: Provide extremely large inputs to exhaust zkVM resources.
**Mitigation**: Input size limits; bounded witness size.

## Recommendations for Implementers

1. **Always validate inputs** before processing
2. **Use bounded reads** when parsing RLP data
3. **Check all error returns** from decoding functions
4. **Limit witness size** to prevent resource exhaustion
5. **Embed chain configs** rather than accepting them as input
6. **Test with fuzzing** to find edge cases
7. **Audit crypto primitives** especially zkVM accelerated ones

## Chain Configuration Trust

Chain configurations (fork blocks, chain IDs, etc.) are compiled into the Keeper binary. This means:

- **Pros**: Cannot be manipulated by malicious provers
- **Cons**: New chains require recompilation

Supported chains are defined in `chainconfig.go` with the appropriate build tags.

## Verification Workflow

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│   Prover    │────▶│    Keeper    │────▶│   Proof    │
│             │     │   (zkVM)     │     │            │
│ - Block     │     │ - Validate   │     │ - Public   │
│ - Witness   │     │ - Execute    │     │   inputs   │
│ - ChainID   │     │ - Compare    │     │ - ZK proof │
└─────────────┘     └──────────────┘     └────────────┘
                           │
                           ▼
                    ┌────────────┐
                    │  Verifier  │
                    │            │
                    │ - Check    │
                    │   proof    │
                    │ - Accept/  │
                    │   Reject   │
                    └────────────┘
```

## References

- [Ethereum Yellow Paper](https://ethereum.github.io/yellowpaper/paper.pdf)
- [EIP-1186: Merkle Proofs](https://eips.ethereum.org/EIPS/eip-1186)
- [Stateless Ethereum](https://ethereum.org/en/roadmap/statelessness/)
- [Ziren zkVM Documentation](https://github.com/ProjectZKM/Ziren)
