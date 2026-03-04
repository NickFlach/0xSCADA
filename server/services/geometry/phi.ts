/**
 * Process Integration Phi (Φ) — measures how well-connected a SCADA system is.
 * 
 * Inspired by IIT (Integrated Information Theory) and ported from kannaka-memory.
 * 
 * Phi answers: "If you cut this system along any boundary, how much
 * information is lost?" A high-Phi plant has sensor data flowing into
 * control actions, alarms triggering maintenance responses, events
 * correlated across assets. A low-Phi plant has siloed departments
 * that don't talk to each other.
 * 
 * Components:
 *   Integration    — fraction of links that cross partition boundaries
 *   Differentiation — how many distinct geometric classes are populated
 *   Density        — how connected the entity graph is
 *   Scale          — normalized by entity count
 */

import type { ScadaCoordinates, ClassComponents } from "./types.js";
import { decodeClassIndex } from "./types.js";
import { isFanoRelated } from "./fano.js";

export interface PhiReport {
  /** Overall Phi score (0..1). Higher = more integrated. */
  phi: number;

  /** Integration: fraction of links crossing partition boundaries */
  integration: number;

  /** Differentiation: diversity of geometric classes */
  differentiation: number;

  /** Density: link density relative to max possible */
  density: number;

  /** Scale factor based on entity count */
  scale: number;

  /** Breakdown by partition scheme */
  partitions: {
    quadrant: { classes: number; crossRatio: number };
    triality: { classes: number; crossRatio: number };
    classIndex: { classes: number; crossRatio: number };
  };

  /** Total entities and links */
  entityCount: number;
  linkCount: number;
  fanoLinkCount: number;

  /** Geometric diversity bonus */
  geometricBonus: number;

  /** Consciousness-style level name */
  level: "dormant" | "stirring" | "aware" | "coherent" | "resonant";
}

interface EntityEntry {
  id: string;
  coords: ScadaCoordinates;
}

interface Link {
  sourceId: string;
  targetId: string;
}

/**
 * Compute Phi for a set of classified entities and their links.
 * 
 * @param entities — classified entities with coordinates
 * @param links — connections between entities (causal, temporal, spatial, etc.)
 */
export function computePhi(
  entities: EntityEntry[],
  links: Link[],
): PhiReport {
  const n = entities.length;

  if (n === 0) {
    return emptyReport();
  }

  // Build lookup maps
  const idToCoords = new Map<string, ScadaCoordinates>();
  for (const e of entities) {
    idToCoords.set(e.id, e.coords);
  }

  const totalLinks = links.length;

  // === Cross-partition ratios for each scheme ===
  const quadrantCross = crossPartitionRatio(links, idToCoords, (c) => c.h2);
  const trialityCross = crossPartitionRatio(links, idToCoords, (c) => c.d);
  const classCross = crossPartitionRatio(links, idToCoords, (c) => c.classIndex);

  // Count Fano-related links
  let fanoLinkCount = 0;
  for (const link of links) {
    const a = idToCoords.get(link.sourceId);
    const b = idToCoords.get(link.targetId);
    if (a && b && isFanoRelated(a, b)) {
      fanoLinkCount++;
    }
  }

  // === Partition diversity ===
  const quadrantClasses = new Set(entities.map((e) => e.coords.h2)).size;
  const trialityClasses = new Set(entities.map((e) => e.coords.d)).size;
  const classIndexClasses = new Set(entities.map((e) => e.coords.classIndex)).size;

  // === Integration (0..1): weighted average of cross-ratios ===
  const integration =
    0.3 * quadrantCross +
    0.3 * trialityCross +
    0.25 * classCross +
    0.15 * (totalLinks > 0 ? fanoLinkCount / totalLinks : 0);

  // === Differentiation (0..1): normalized diversity ===
  const differentiation =
    0.3 * (Math.min(quadrantClasses, 4) / 4) +
    0.3 * (Math.min(trialityClasses, 3) / 3) +
    0.4 * (Math.min(classIndexClasses, 96) / 96);

  // === Density (0..1): sigmoid of link density ===
  const maxLinks = n * (n - 1);
  const linkDensity = maxLinks > 0 ? totalLinks / maxLinks : 0;
  const density = sigmoid(10 * linkDensity - 3);

  // === Scale (0..1): log of entity count, normalized ===
  const scale = n > 1 ? Math.min(Math.log(n) / Math.log(10), 1.0) : 0;

  // === Combine ===
  let phi = Math.min(integration * differentiation * density * scale * 4.0, 1.0);

  // Geometric diversity bonus (small, caps at 0.1)
  const geometricBonus = (classIndexClasses / 96) * 0.1;
  phi = Math.min(phi + geometricBonus, 1.0);

  // Level
  const level = phiToLevel(phi);

  return {
    phi,
    integration,
    differentiation,
    density,
    scale,
    partitions: {
      quadrant: { classes: quadrantClasses, crossRatio: quadrantCross },
      triality: { classes: trialityClasses, crossRatio: trialityCross },
      classIndex: { classes: classIndexClasses, crossRatio: classCross },
    },
    entityCount: n,
    linkCount: totalLinks,
    fanoLinkCount,
    geometricBonus,
    level,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function crossPartitionRatio(
  links: Link[],
  idToCoords: Map<string, ScadaCoordinates>,
  keyFn: (c: ScadaCoordinates) => number,
): number {
  let total = 0;
  let cross = 0;
  for (const link of links) {
    const a = idToCoords.get(link.sourceId);
    const b = idToCoords.get(link.targetId);
    if (!a || !b) continue;
    total++;
    if (keyFn(a) !== keyFn(b)) {
      cross++;
    }
  }
  return total > 0 ? cross / total : 0;
}

function sigmoid(x: number): number {
  return (Math.tanh(x) + 1) * 0.5;
}

function phiToLevel(phi: number): PhiReport["level"] {
  if (phi < 0.1) return "dormant";
  if (phi < 0.3) return "stirring";
  if (phi < 0.6) return "aware";
  if (phi < 0.8) return "coherent";
  return "resonant";
}

function emptyReport(): PhiReport {
  return {
    phi: 0,
    integration: 0,
    differentiation: 0,
    density: 0,
    scale: 0,
    partitions: {
      quadrant: { classes: 0, crossRatio: 0 },
      triality: { classes: 0, crossRatio: 0 },
      classIndex: { classes: 0, crossRatio: 0 },
    },
    entityCount: 0,
    linkCount: 0,
    fanoLinkCount: 0,
    geometricBonus: 0,
    level: "dormant",
  };
}
