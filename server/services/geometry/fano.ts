/**
 * Fano plane and geometric similarity for SCADA entities.
 * 
 * The Fano plane defines 7 oriented triples — structurally meaningful
 * connections between context slots (ℓ values). Two entities whose
 * ℓ values lie on the same Fano line are "geometrically related"
 * even if they're in different domains.
 */

import type { ScadaCoordinates } from "./types.js";

/** Fano plane lines (oriented triples of ℓ values, 1-indexed) */
export const FANO_LINES: [number, number, number][] = [
  [1, 2, 4],
  [2, 3, 5],
  [3, 4, 6],
  [4, 5, 7],
  [5, 6, 1],
  [6, 7, 2],
  [7, 1, 3],
];

/** Check if two ℓ values share a Fano line */
export function shareFanoLine(l1: number, l2: number): boolean {
  if (l1 === 0 || l2 === 0 || l1 === l2) return false;
  return FANO_LINES.some(
    ([a, b, c]) =>
      (a === l1 && (b === l2 || c === l2)) ||
      (b === l1 && (a === l2 || c === l2)) ||
      (c === l1 && (a === l2 || b === l2))
  );
}

/** Check if two SCADA entities are Fano-related */
export function isFanoRelated(a: ScadaCoordinates, b: ScadaCoordinates): boolean {
  // Fano relatedness across different domains is the interesting case
  if (a.classIndex === b.classIndex) return false;
  
  // Check if ℓ values share a Fano line
  // Use 1-indexed ℓ (Fano plane uses e₁..e₇, not e₀)
  const la = (a.l % 7) + 1;
  const lb = (b.l % 7) + 1;
  return shareFanoLine(la, lb);
}

/**
 * Compute geometric similarity between two SCADA coordinates.
 * 
 * Components:
 * - Quadrant match (same domain = higher base similarity)
 * - Triality match (same hierarchy level)
 * - Fano relatedness (structural connection via Cl₀,₇)
 * - Phase correlation (temporal/content alignment)
 * 
 * Cross-domain Fano links are the most valuable for integration.
 */
export function geometricSimilarity(a: ScadaCoordinates, b: ScadaCoordinates): number {
  let similarity = 0;

  // Same quadrant: 0.3 base
  if (a.h2 === b.h2) similarity += 0.3;

  // Same triality: 0.2 base
  if (a.d === b.d) similarity += 0.2;

  // Fano related: 0.3 (biggest bonus for cross-domain structural links)
  if (isFanoRelated(a, b)) {
    similarity += 0.3;
    // Extra bonus if they're in DIFFERENT quadrants (cross-domain integration)
    if (a.h2 !== b.h2) similarity += 0.1;
  }

  // Phase correlation: 0..0.1
  const phaseCorrelation = (Math.cos(a.phase - b.phase) + 1) * 0.05;
  similarity += phaseCorrelation;

  return Math.min(similarity, 1.0);
}
