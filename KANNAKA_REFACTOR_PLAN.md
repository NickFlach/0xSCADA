# Kannaka Memory: Refactoring & Improvement Plan

**Status:** Analysis Complete  
**Date:** 2025-03-04  
**Target:** `server/services/geometry/` (0xSCADA)

## 1. Executive Summary
The `kannaka-memory` module (ported to 0xSCADA as the geometry service) provides a unique "Sacred Geometry" approach to SCADA system classification. While functional, the current implementation contains algorithmic biases that skew the geometric distribution and keyword matching logic that is brittle to complex entity names.

This plan outlines specific fixes for identified bugs and structural refactoring to align the code with its "perfect symmetry" design goals.

## 2. Identified Issues

### 2.1. The "Heavy Point" Fano Collision (Bug)
**Severity:** Medium (Geometric Bias)  
**Location:** `server/services/geometry/fano.ts` & `classifier.ts`

The current implementation uses a modulo-8 system (`l = hash % 8`) for the third geometric coordinate, resulting in 8 possible slots (0-7). However, the Fano plane has exactly 7 points.
The mapping logic `(l % 7) + 1` forces a collision:
- `l=0` → Point 1
- `l=7` → Point 1

**Impact:** Fano Point 1 receives double the probability mass (2/8 = 25%) compared to Points 2-7 (1/8 = 12.5%). This breaks the "perfect projective symmetry" intended by the design.

### 2.2. Classifier Keyword Precedence (Bug)
**Severity:** Low (Classification Inaccuracy)  
**Location:** `server/services/geometry/classifier.ts`

The `classifyQuadrant` function uses a strictly ordered `if-else` chain.
- IF (sensor keywords) → Sensor
- ELSE IF (control keywords) → Control

**Impact:** An entity named "Sensor Control Unit" is classified purely as **Sensor** because "sensor" is checked first. The "control" aspect is ignored. This makes classification order-dependent rather than semantic.

### 2.3. Hardcoded Heuristics (Refactoring)
**Location:** `server/services/geometry/classifier.ts`

Keyword lists (e.g., "temperature", "valve", "alarm") are hardcoded within the function body. This makes it difficult to extend the system or load configuration from an external source (like a database or JSON file).

## 3. Proposed Improvements

### 3.1. Alignment to Modulo-7 (Fixing Fano)
To achieve true symmetry, we must resolve the 8-slot vs 7-point conflict.

**Recommendation:** Change the system to use **96 classes** → **84 classes** (4 Quadrants × 3 Trialities × 7 Slots).
- Change `l` calculation to `hash % 7`.
- This ensures a perfect 1:1 mapping between `l` values and Fano points.
- **Trade-off:** slightly fewer total classes, but mathematically pure geometry.

**Alternative:** If 96 classes are required for other reasons (e.g. byte alignment), we must explicitly designate `l=0` as a "Void" or "Center" point that is *not* on the Fano plane, and map `l=1..7` to the 7 points.

### 3.2. Weighted Keyword Classification (Fixing Precedence)
Replace the `if-else` chain with a scoring system.

**Logic:**
1. Initialize scores: `{ Sensor: 0, Control: 0, Alarm: 0, Maintenance: 0 }`
2. Scan string for keywords.
   - "sensor" → Sensor +1
   - "control" → Control +1
3. Select the Quadrant with the highest score.
4. **Tie-breaking:** Use the `contentHash` to deterministically break ties if scores are equal.

### 3.3. Configurable Keyword Dictionaries
Extract keywords into a `ClassificationConfig` object or constant.

```typescript
const KEYWORDS = {
  [Quadrant.Sensor]: ["sensor", "reading", "temp", ...],
  [Quadrant.Control]: ["control", "command", "setpoint", ...],
  // ...
};
```

## 4. Implementation Plan

### Phase 1: Core Geometry Fixes
1.  **Modify `classifier.ts`**: Change `l` calculation to `contentHash(...) % 7`.
2.  **Update `types.ts`**: Update `componentsToClassIndex` and `decodeClassIndex` to use base-7 for the `l` component (multiplier becomes `7` instead of `8`, total classes 84).
3.  **Update Tests**: Fix `geometry.test.ts` to expect 84 classes and uniform distribution.

### Phase 2: Classifier Robustness
1.  **Refactor `classifyQuadrant`**: Implement the weighted scoring system.
2.  **Extract Constants**: Move keyword lists to top-level constants or a separate file.
3.  **Verify**: Run `repro_bugs.test.ts` to ensure "Sensor Control Unit" is handled deterministically (likely a tie, broken by hash, or weighted by specific keyword strength).

### Phase 3: Documentation
1.  Update `ADR-0025` if necessary to reflect the 84-class system.
2.  Add JSDoc explaining the 7-point symmetry.

## 5. Verification
Run the provided `repro_bugs.test.ts` (modified to assert the new behavior) to confirm:
- `l` values 0-6 are uniformly distributed.
- `isFanoRelated` works correctly for all points.
- Ambiguous names are classified via scoring/tie-breaker logic.
