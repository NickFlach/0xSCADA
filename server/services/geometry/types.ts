/**
 * SGA types for SCADA geometric classification.
 */

/** h₂ quadrant — domain of the entity */
export enum Quadrant {
  Sensor = 0,      // Technical readings, measurements
  Control = 1,     // Setpoints, commands, operator actions
  Alarm = 2,       // Anomalies, state changes, events
  Maintenance = 3, // Work orders, compliance, calibration
}

/** d — triality phase (entity hierarchy level) */
export enum Triality {
  Site = 0,   // Plant/facility level
  Asset = 1,  // Equipment/device level
  Event = 2,  // Occurrence/record level
}

/** Components of a class: (h₂, d, ℓ) */
export interface ClassComponents {
  h2: Quadrant;  // 0..3
  d: Triality;   // 0..2
  l: number;     // 0..6 (context slot from Cl₀,₆)
}

/** Full geometric coordinates for a SCADA entity */
export interface ScadaCoordinates {
  h2: Quadrant;
  d: Triality;
  l: number;
  classIndex: number;  // 0..83
  amplitude: number;   // Signal strength (0..1)
  phase: number;       // Phase angle (0..2π)
}

/** A classified entity with its coordinates */
export interface ClassifiedEntity {
  entityId: string;
  coordinates: ScadaCoordinates;
  timestamp: number;
}

/** Cross-partition link between two entities */
export interface GeometricLink {
  sourceId: string;
  targetId: string;
  sourceClass: number;
  targetClass: number;
  strength: number;      // 0..1
  crossesQuadrant: boolean;
  crossesTriality: boolean;
  fanoRelated: boolean;
}

/** Encode components to class index: 21*h2 + 7*d + l */
// Total classes = 4 * 3 * 7 = 84
// h2 (0-3) * 21 -> 0, 21, 42, 63
// d (0-2) * 7 -> 0, 7, 14
// l (0-6) -> 0..6
export function componentsToClassIndex(comp: ClassComponents): number {
  return 21 * comp.h2 + 7 * comp.d + comp.l;
}

/** Decode class index to components */
export function decodeClassIndex(classIndex: number): ClassComponents {
  if (classIndex < 0 || classIndex > 83) {
    throw new Error(`Class index ${classIndex} out of range [0..83]`);
  }
  const h2 = Math.floor(classIndex / 21) as Quadrant;
  const remainder = classIndex % 21;
  const d = Math.floor(remainder / 7) as Triality;
  const l = remainder % 7;
  return { h2, d, l };
}
