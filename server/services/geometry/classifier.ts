/**
 * Entity classifier — maps SCADA entities to 84-class SGA coordinates.
 * 
 * Classification heuristics:
 *   h₂: Determined by entity type / event type / property names (weighted scoring)
 *   d:  Determined by entity hierarchy (site > asset > event)
 *   ℓ:  Content hash mod 7 (distributes within domain, perfect Fano alignment)
 */

import {
  Quadrant,
  Triality,
  type ScadaCoordinates,
  componentsToClassIndex,
} from "./types.js";

/** Keyword dictionaries for weighted classification */
const KEYWORDS: Record<Quadrant, string[]> = {
  [Quadrant.Sensor]: [
    "sensor", "reading", "temperature", "pressure", "flow", "level",
    "historian", "tag", "measurement", "analog", "meter", "gauge"
  ],
  [Quadrant.Control]: [
    "control", "command", "setpoint", "output", "actuator", "valve",
    "pid", "recipe", "relay", "switch", "motor", "drive"
  ],
  [Quadrant.Alarm]: [
    "alarm", "alert", "fault", "trip", "deviation", "anomaly",
    "event", "incident", "warning", "error", "critical"
  ],
  [Quadrant.Maintenance]: [
    "maintenance", "calibration", "inspection", "work_order",
    "compliance", "certification", "audit", "repair", "service"
  ]
};

/** Simple string hash (same as kannaka-memory) */
function contentHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Classify by explicit quadrant name using weighted scoring */
function classifyQuadrant(entityType: string, properties: Record<string, unknown> = {}): Quadrant {
  const t = entityType.toLowerCase();
  const propKeys = Object.keys(properties).join(" ").toLowerCase();
  const combined = `${t} ${propKeys}`;

  // Initialize scores
  const scores: Record<Quadrant, number> = {
    [Quadrant.Sensor]: 0,
    [Quadrant.Control]: 0,
    [Quadrant.Alarm]: 0,
    [Quadrant.Maintenance]: 0
  };

  // Calculate scores based on keyword matches
  // Matches in entityType are weighted higher (2x) than property keys (1x)
  for (const [qStr, keywords] of Object.entries(KEYWORDS)) {
    const q = Number(qStr) as Quadrant;
    for (const kw of keywords) {
      if (t.includes(kw)) scores[q] += 2;
      if (propKeys.includes(kw)) scores[q] += 1;
    }
  }

  // Find quadrant with max score
  let maxScore = -1;
  let bestQuadrant: Quadrant | null = null;
  let tie = false;

  for (const [qStr, score] of Object.entries(scores)) {
    const q = Number(qStr) as Quadrant;
    if (score > maxScore) {
      maxScore = score;
      bestQuadrant = q;
      tie = false;
    } else if (score === maxScore) {
      tie = true;
    }
  }

  // If no keywords matched, or there was a tie, use hash to break tie deterministically
  if (maxScore === 0 || tie || bestQuadrant === null) {
    return (contentHash(t) % 4) as Quadrant;
  }

  return bestQuadrant;
}

/** Classify triality by entity hierarchy */
function classifyTriality(entityType: string, entityId: string): Triality {
  const t = entityType.toLowerCase();
  const id = entityId.toLowerCase();

  // Site-level
  if (t.includes("site") || t.includes("plant") || t.includes("facility") || t.includes("area")) {
    return Triality.Site;
  }

  // Asset-level
  if (
    t.includes("asset") || t.includes("equipment") || t.includes("device") ||
    t.includes("pump") || t.includes("valve") || t.includes("motor") ||
    t.includes("inverter") || t.includes("sensor") || t.includes("plc") ||
    t.includes("tag")
  ) {
    return Triality.Asset;
  }

  // Event-level (default for most things)
  if (
    t.includes("event") || t.includes("alarm") || t.includes("record") ||
    t.includes("reading") || t.includes("log") || t.includes("anchor") ||
    t.includes("maintenance") || t.includes("audit")
  ) {
    return Triality.Event;
  }

  // Guess from ID patterns
  if (id.includes("site")) return Triality.Site;
  if (id.includes("asset") || id.includes("tag")) return Triality.Asset;

  return Triality.Event;
}

/**
 * Classify a raw entity type + properties into SGA coordinates.
 */
export function classify(
  entityType: string,
  entityId: string,
  properties: Record<string, unknown> = {},
  importance: number = 0.5,
): ScadaCoordinates {
  const h2 = classifyQuadrant(entityType, properties);
  const d = classifyTriality(entityType, entityId);
  // Use modulo 7 for perfect Fano plane alignment (0-6)
  const l = contentHash(`${entityId}:${entityType}`) % 7;

  const classIndex = componentsToClassIndex({ h2, d, l });
  const amplitude = Math.min(importance * 0.5 + 0.5, 1.0);
  const phase = (contentHash(entityId) * 0.01) % (2 * Math.PI);

  return { h2, d, l, classIndex, amplitude, phase };
}

/**
 * Classify a Flux entity (convenience wrapper).
 * Infers type from entity ID prefix and property keys.
 */
export function classifyEntity(
  entityId: string,
  properties: Record<string, unknown> = {},
): ScadaCoordinates {
  // Infer entity type from Flux entity ID conventions
  // e.g., "scada/site/plant-1", "scada/asset/pump-01", "scada/event/alarm-123"
  const parts = entityId.split("/");
  const entityType = parts.length > 1 ? parts.slice(0, -1).join("/") : entityId;

  // Estimate importance from property richness
  const propCount = Object.keys(properties).length;
  const importance = Math.min(propCount / 20, 1.0);

  return classify(entityType, entityId, properties, importance);
}
