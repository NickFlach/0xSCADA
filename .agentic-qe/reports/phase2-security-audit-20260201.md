# 🔐 Phase 2: Smart Contract Security Audit
## 0xSCADA Quality Engineering Campaign

**Generated**: 2026-02-01T04:35:00Z  
**Agent**: qe-queen-coordinator → qe-security-scanner + qe-security-auditor  
**Model Tier**: Opus (critical security)  
**Status**: ✅ Complete

---

## 📊 Audit Summary

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 2 | Requires immediate fix |
| 🟠 High | 4 | Should fix before mainnet |
| 🟡 Medium | 5 | Recommended fixes |
| 🔵 Low | 3 | Informational |
| ✅ Good Practices | 8 | Commendations |

**Overall Risk Level**: 🟠 **HIGH** — Critical issues in access control and ID generation

---

## 🔴 CRITICAL FINDINGS

### C-01: Predictable Anchor ID Generation (Front-Running)

**Contract**: `EventAnchor.sol` (Line 83-88)  
**Severity**: 🔴 Critical  
**CVSS**: 8.1 (High)

```solidity
// VULNERABLE: All parameters are predictable/known before tx
anchorId = keccak256(abi.encodePacked(
    siteId,
    merkleRoot,
    block.timestamp,  // Miner-controlled
    msg.sender        // Known
));
```

**Attack Vector**:
1. Attacker monitors mempool for `anchorBatch()` calls
2. Calculates expected `anchorId` using same inputs
3. Front-runs with same Merkle root but different metadata
4. Original anchor fails with "Anchor already exists"

**Impact**: 
- Denial of service on event anchoring
- Malicious metadata injection
- Industrial audit trail corruption

**Recommendation**:
```solidity
// Use commit-reveal or include nonce
anchorId = keccak256(abi.encodePacked(
    siteId,
    merkleRoot,
    block.number,  // Less predictable
    msg.sender,
    nonce++        // Incrementing nonce
));
```

---

### C-02: Predictable Intent ID Generation (Front-Running)

**Contract**: `ChangeIntent.sol` (Line 109-115)  
**Severity**: 🔴 Critical  
**CVSS**: 7.8 (High)

```solidity
// SAME VULNERABILITY as C-01
intentId = keccak256(abi.encodePacked(
    siteId,
    blueprintHash,
    codeHash,
    block.timestamp,
    msg.sender
));
```

**Attack Vector**:
1. Attacker sees pending `createIntent()` in mempool
2. Creates identical intent with malicious `changePackageHash`
3. Original transaction reverts
4. Attacker's change package is now the "official" one

**Impact**:
- PLC/SCADA code substitution attack
- Malicious industrial control logic deployment
- **SAFETY-CRITICAL**: Could cause physical harm

**Recommendation**:
```solidity
// Add user-provided salt or use CREATE2 pattern
function createIntent(
    bytes32 siteId,
    bytes32 blueprintHash,
    bytes32 codeHash,
    bytes32 changePackageHash,
    uint256 requiredApprovals,
    bytes32 salt  // User provides unique salt
) external returns (bytes32 intentId) {
    intentId = keccak256(abi.encodePacked(
        siteId, blueprintHash, codeHash, salt, msg.sender
    ));
    // ...
}
```

---

## 🟠 HIGH SEVERITY FINDINGS

### H-01: Missing Bounds Check in Merkle Proof Verification

**Contract**: `EventAnchor.sol` (Line 133-159)  
**Severity**: 🟠 High

```solidity
function _verifyMerkleProof(
    bytes32 leaf,
    bytes32[] calldata proof,
    bytes32 root,
    uint256 index  // ⚠️ No validation against proof.length
) internal pure returns (bool) {
    bytes32 computedHash = leaf;
    
    for (uint256 i = 0; i < proof.length; i++) {
        // ...
        index = index / 2;  // ⚠️ Index could overflow for malformed proofs
    }
    
    return computedHash == root;
}
```

**Issue**: No validation that `index < 2^proof.length`

**Impact**: 
- Incorrect verification results possible
- False positives on proof verification

**Recommendation**:
```solidity
require(index < (1 << proof.length), "Index out of bounds for proof length");
```

---

### H-02: IndustrialRegistry Uses String Keys (Gas & Collision Risk)

**Contract**: `IndustrialRegistry.sol`  
**Severity**: 🟠 High

```solidity
// ⚠️ String mappings are gas-expensive and collision-prone
mapping(string => SiteRegistry) public sites;
mapping(string => AssetRegistry) public assets;
```

**Issues**:
1. String comparison is O(n) vs bytes32 O(1)
2. No length validation on string keys
3. Potential hash collision with user-controlled input
4. Gas costs ~10x higher than bytes32

**Impact**:
- Gas griefing with long strings
- Potential key collisions
- Inconsistent with other contracts using bytes32

**Recommendation**:
```solidity
// Use bytes32 with off-chain string→hash mapping
mapping(bytes32 => SiteRegistry) public sites;

function registerSite(bytes32 siteId, ...) external {
    // siteId = keccak256(abi.encodePacked(stringId))
}
```

---

### H-03: No Site Reactivation Mechanism

**Contract**: `SiteRegistry.sol` (Line 97-100)  
**Severity**: 🟠 High

```solidity
function deactivateSite(bytes32 siteId) 
    external 
    onlySiteOwner(siteId) 
    siteExists(siteId) 
{
    sites[siteId].active = false;  // ⚠️ Permanent, no reactivation
    emit SiteDeactivated(siteId, block.timestamp);
}
```

**Issue**: Once deactivated, site cannot be reactivated. Same siteId cannot be re-registered.

**Impact**:
- Accidental deactivation is permanent
- No recovery mechanism
- Could orphan anchored events

**Recommendation**:
```solidity
function reactivateSite(bytes32 siteId) 
    external 
    onlySiteOwner(siteId) 
{
    require(!sites[siteId].active, "Site already active");
    require(sites[siteId].registeredAt > 0, "Site never existed");
    sites[siteId].active = true;
    emit SiteReactivated(siteId, block.timestamp);
}
```

---

### H-04: Missing Authorization Check Pattern

**Contract**: `IndustrialRegistry.sol` (Line 69-87)  
**Severity**: 🟠 High

```solidity
// ⚠️ Anyone can register a site - no authorization required
function registerSite(
    string memory siteId,
    string memory name,
    string memory location,
    address owner  // ⚠️ Can set arbitrary owner
) external {
    require(!sites[siteId].active, "Site already registered");
    // ...
}
```

**Issue**: Unlike `SiteRegistry.sol`, this contract allows anyone to register sites with any owner address.

**Impact**:
- Squatting on site IDs
- Setting malicious owners
- Inconsistent access control between contracts

**Recommendation**:
```solidity
// Option 1: msg.sender must be owner
function registerSite(...) external {
    sites[siteId].owner = msg.sender;  // Force caller as owner
}

// Option 2: Admin/governance only
modifier onlyAdmin() { require(msg.sender == admin, "Not admin"); _; }
function registerSite(...) external onlyAdmin { ... }
```

---

## 🟡 MEDIUM SEVERITY FINDINGS

### M-01: Unbounded Array Growth

**Contracts**: All 4 contracts  
**Severity**: 🟡 Medium

```solidity
// EventAnchor.sol
bytes32[] public anchorIds;      // Unbounded
bytes32[] public siteAnchors;    // Unbounded per site

// SiteRegistry.sol  
bytes32[] public siteIds;        // Unbounded

// ChangeIntent.sol
bytes32[] public intentIds;      // Unbounded
address[] public intentApprovers; // Unbounded per intent
```

**Issue**: No maximum limits, could lead to:
- Gas limit DoS on iteration
- Storage bloat

**Recommendation**: Implement pagination or use EnumerableSet with limits.

---

### M-02: Missing Event for Gateway/Signer Count

**Contract**: `SiteRegistry.sol`  
**Severity**: 🟡 Medium

**Issue**: No way to enumerate all authorized gateways/signers for a site on-chain.

**Impact**: Off-chain indexers must track all historical events.

**Recommendation**: Add counter or EnumerableSet for gateways/signers.

---

### M-03: Timestamp Dependency

**Contracts**: All 4 contracts  
**Severity**: 🟡 Medium

```solidity
registeredAt: block.timestamp,  // Miner can manipulate ±15 seconds
createdAt: block.timestamp,
anchoredAt: block.timestamp,
```

**Issue**: `block.timestamp` can be manipulated by miners within ~15 second window.

**Impact**: Minor—timestamps are for audit trail, not critical logic.

**Recommendation**: Document that timestamps are approximate. Consider `block.number` for ordering.

---

### M-04: No Intent Expiration

**Contract**: `ChangeIntent.sol`  
**Severity**: 🟡 Medium

**Issue**: PENDING intents never expire.

**Impact**:
- Stale intents accumulate forever
- Approved intents with old code could be deployed later

**Recommendation**:
```solidity
uint256 public constant INTENT_EXPIRY = 7 days;

function isExpired(bytes32 intentId) public view returns (bool) {
    return block.timestamp > intents[intentId].createdAt + INTENT_EXPIRY;
}
```

---

### M-05: Missing Re-entrancy Guards

**Contracts**: All 4 contracts  
**Severity**: 🟡 Medium (Low risk in current implementation)

**Issue**: No `nonReentrant` modifier, though current code doesn't make external calls with value.

**Impact**: Future modifications could introduce re-entrancy.

**Recommendation**: Add OpenZeppelin's `ReentrancyGuard` as defensive measure.

---

## 🔵 LOW/INFORMATIONAL

### L-01: Missing SPDX License Consistency

All contracts use MIT license—consistent. ✅

### L-02: Solidity Version

Using `^0.8.20`—good for overflow protection. Consider locking to specific version for production.

### L-03: Missing NatSpec on Some Functions

View functions lack complete NatSpec documentation.

---

## ✅ GOOD PRACTICES OBSERVED

| Practice | Contracts | Notes |
|----------|-----------|-------|
| ✅ Solidity 0.8+ overflow protection | All | Built-in SafeMath |
| ✅ Immutable state for cross-contract refs | EventAnchor, ChangeIntent | `immutable siteRegistry` |
| ✅ Proper access modifiers | SiteRegistry, ChangeIntent | onlySiteOwner pattern |
| ✅ Event emission on state changes | All | Good audit trail |
| ✅ Input validation (zero address, empty values) | All | require statements |
| ✅ View function separation | All | Pure/view correctly used |
| ✅ No selfdestruct | All | Cannot be destroyed |
| ✅ No delegatecall | All | No proxy patterns |

---

## 🧪 RECOMMENDED TEST CASES

### Critical Tests (Must Have)

```solidity
// C-01/C-02: Front-running tests
function test_frontRunAnchorBatch() public {
    // Setup: Create valid anchor params
    // Action: Simulate front-run with same merkle root
    // Assert: Original tx should succeed (after fix)
}

// H-01: Merkle proof bounds
function test_merkleProofIndexOverflow() public {
    // Create proof with mismatched index
    // Should revert with bounds error
}

// H-04: Authorization
function test_cannotRegisterSiteAsArbitraryOwner() public {
    // Attempt to register site with different owner
    // Should force msg.sender as owner
}
```

### High Priority Tests

```solidity
// Site lifecycle
function test_deactivateAndReactivateSite() public {}
function test_cannotAnchorToDeactivatedSite() public {}

// Intent lifecycle
function test_intentExpiry() public {}
function test_cannotDeployExpiredIntent() public {}

// Authorization edge cases
function test_revokedSignerCannotApprove() public {}
function test_ownerTransferPreservesGateways() public {}
```

---

## 📋 REMEDIATION PRIORITY

| ID | Severity | Effort | Priority |
|----|----------|--------|----------|
| C-01 | 🔴 Critical | Medium | P0 - Immediate |
| C-02 | 🔴 Critical | Medium | P0 - Immediate |
| H-01 | 🟠 High | Low | P1 - Before audit |
| H-04 | 🟠 High | Low | P1 - Before audit |
| H-02 | 🟠 High | High | P2 - Refactor |
| H-03 | 🟠 High | Low | P2 - Nice to have |
| M-01 | 🟡 Medium | Medium | P3 - Future |
| M-04 | 🟡 Medium | Low | P3 - Future |

---

## 🔗 References

- [SWC Registry](https://swcregistry.io/) - Smart Contract Weakness Classification
- [OpenZeppelin Security](https://docs.openzeppelin.com/contracts/4.x/api/security)
- [Consensys Best Practices](https://consensys.github.io/smart-contract-best-practices/)

---

*Report generated by Agentic-QE Security Scanner*  
*Verification: Manual code review + pattern analysis*
