# 0xSCADA Fuzz Testing Documentation

## Overview

This document describes the fuzz testing infrastructure for the 0xSCADA protocol handlers.
Fuzz testing systematically generates malformed, random, and edge-case inputs to discover 
input validation vulnerabilities, parsing bugs, and denial-of-service vectors.

**Issue Reference:** #55 - Security Fuzz Testing for Protocol Handlers

## Quick Start

```bash
# Install dependencies (if not already done)
npm install

# Run TypeScript fuzz tests
npm run test:fuzz

# Run all tests including fuzz
npm run test

# Run Solidity fuzz tests with Hardhat
npx hardhat test contracts/test/fuzz/*.sol
```

## Test Structure

### TypeScript Fuzz Tests (`server/__tests__/fuzz/`)

| File | Coverage |
|------|----------|
| `merkle-proof.fuzz.test.ts` | Merkle tree construction, proof generation/verification |
| `api-input-validation.fuzz.test.ts` | API schema validation, injection attacks |
| `batch-anchoring.fuzz.test.ts` | Batch service state, edge cases |
| `crypto.fuzz.test.ts` | Hash functions, HMAC, canonicalization |

### Solidity Fuzz Tests (`contracts/test/fuzz/`)

| File | Coverage |
|------|----------|
| `EventAnchor.fuzz.t.sol` | Merkle proof verification, batch anchoring |
| `SiteRegistry.fuzz.t.sol` | Authorization, access control |

## Test Categories

### 1. Merkle Proof Verification
- Valid proofs always verify
- Invalid leaf hashes fail verification
- Tampered proofs fail verification
- Edge cases: single element, power-of-2 sizes, duplicate leaves

### 2. API Input Validation
- SQL injection payloads
- XSS payloads
- Unicode normalization attacks
- Prototype pollution attempts
- NoSQL injection patterns
- Command injection patterns
- Path traversal attempts
- Oversized inputs

### 3. Batch Anchoring
- Rapid event queueing
- Concurrent batch triggers
- Config updates during operation
- Memory pressure (history limits)
- Timestamp edge cases

### 4. Cryptographic Functions
- SHA-256 determinism and collision resistance
- Avalanche effect verification
- HMAC signing and verification
- Canonical JSON serialization
- Ethereum address validation

### 5. Smart Contract Security
- Authorization checks
- State transition validation
- Input boundary conditions
- Reentrancy protection (implicit in design)

## Property-Based Testing with fast-check

The TypeScript tests use [fast-check](https://github.com/dubzzz/fast-check) for 
property-based testing. Key properties tested:

```typescript
// Example: Merkle proof validity
fc.assert(
  fc.property(
    fc.array(fc.hexaString({ minLength: 8, maxLength: 64 }), { minLength: 1, maxLength: 100 }),
    (hashes) => {
      const tree = buildMerkleTree(hashes);
      for (let i = 0; i < hashes.length; i++) {
        const proof = getMerkleProof(tree, i);
        expect(verifyMerkleProof(hashes[i], proof, tree.root, i)).toBe(true);
      }
    }
  ),
  { numRuns: 100 }
);
```

### Configuration

- Default: 100 runs per property
- Long tests: 10-50 runs (for expensive operations)
- High coverage: 500-1000 runs (for critical paths)

## Security Payloads Tested

### SQL Injection
```
'; DROP TABLE sites; --
1' OR '1'='1
1; SELECT * FROM users
' UNION SELECT * FROM users--
1' AND SLEEP(5)--
```

### XSS
```html
<script>alert("XSS")</script>
"><img src=x onerror=alert(1)>
javascript:alert('XSS')
<svg onload=alert(1)>
```

### Template Injection
```
${7*7}
{{7*7}}
#{7*7}
<%= 7*7 %>
${T(java.lang.Runtime).getRuntime().exec("whoami")}
```

### Prototype Pollution
```
__proto__
constructor
__defineGetter__
```

### Command Injection
```
; ls -la
| cat /etc/passwd
`whoami`
$(whoami)
& net user
```

## Solidity Fuzzing with Hardhat

The Solidity tests use Hardhat's built-in testing framework with manual fuzz inputs.
For more comprehensive fuzzing, consider:

1. **Foundry** - Built-in fuzzer with `forge test`
2. **Echidna** - Property-based fuzzer for Solidity
3. **Slither** - Static analysis

### Running Solidity Fuzz Tests

```bash
# Basic validation (quick)
npx hardhat test contracts/test/fuzz/*.sol

# With gas reporting
REPORT_GAS=true npx hardhat test contracts/test/fuzz/*.sol

# Specific test
npx hardhat test contracts/test/fuzz/EventAnchor.fuzz.t.sol
```

## Findings and Vulnerabilities

### Critical (P0)
*None discovered*

### High (P1)
*None discovered*

### Medium (P2)
*None discovered*

### Low (P3) / Informational

1. **Unicode normalization** - Input strings are not normalized, which could lead to 
   different representations of the same logical value. Consider normalizing input 
   strings (NFC/NFD).

2. **Large input handling** - Very large payloads (100KB+) may cause performance 
   degradation but do not crash the system. Consider implementing explicit size limits.

## CI Integration

Add to your CI pipeline:

```yaml
# GitHub Actions example
- name: Run Fuzz Tests
  run: |
    npm run test:fuzz
    npx hardhat test contracts/test/fuzz/*.sol
```

For nightly extended fuzzing:

```yaml
# Extended fuzzing job (nightly)
fuzz-extended:
  runs-on: ubuntu-latest
  timeout-minutes: 60
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - name: Extended Fuzz Tests
      run: npm run test:fuzz -- --reporter=verbose
      env:
        FUZZ_RUNS: 1000  # Increase run count
```

## Extending the Tests

### Adding New TypeScript Fuzz Tests

1. Create file in `server/__tests__/fuzz/`
2. Import fast-check: `import * as fc from 'fast-check';`
3. Use `fc.assert()` with property definitions
4. Add to the test suite

```typescript
import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';

describe('Fuzz: MyComponent', () => {
  it('should handle random inputs', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (input) => {
          // Test your property
          expect(myFunction(input)).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

### Adding New Solidity Fuzz Tests

1. Create file in `contracts/test/fuzz/`
2. Prefix fuzz functions with `fuzz_`
3. Add `runBasicValidation()` for quick checks

```solidity
function fuzz_myProperty(uint256 randomInput) external {
    // Test property with random input
    require(someCondition, "Property violated");
    emit TestPassed("fuzz_myProperty");
}
```

## References

- [fast-check Documentation](https://github.com/dubzzz/fast-check)
- [Property-Based Testing](https://hypothesis.works/articles/what-is-property-based-testing/)
- [Hardhat Testing](https://hardhat.org/hardhat-runner/docs/guides/test-contracts)
- [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [Smart Contract Security](https://github.com/crytic/building-secure-contracts)
