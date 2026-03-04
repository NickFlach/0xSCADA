/**
 * Entity classifier — maps SCADA entities to 96-class SGA coordinates.
 * 
 * Classification heuristics:
 *   h₂: Determined by entity type / event type / property names
 *   d:  Determined by entity hierarchy (site > asset > event)
 *   ℓ:  Content hash mod 8 (distributes within domain)
 */

import {
  Quadrant,
  Triality,
  type ScadaCoordinates,
  type ClassComponents,
  componentsToClassIndex,
} from "./types.js";

/** Simple string hash (same as kannaka-memory) */
function contentHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Classify by explicit quadrant name */
function classifyQuadrant(entityType: string, properties: Record<string, unknown> = {}): Quadrant {
  const t = entityType.toLowerCase();
  const propKeys = Object.keys(properties).join(" ").toLowerCase();
  const combined = `${t} ${propKeys}`;

  // Sensor / measurement domain
  if (
    combined.includes("sensor") || combined.includes("reading") ||
    combined.includes("temperature") || combined.includes("pressure") ||
    combined.includes("flow") || combined.includes("level") ||
    combined.includes("historian") || combined.includes("tag") ||
    combined.includes("measurement") || combined.includes("analog")
  ) {
    return Quadrant.Sensor;
  }

  // Control / command domain
  if (
    combined.includes("control") || combined.includes("command") ||
    combined.includes("setpoint") || combined.includes("output") ||
    combined.includes("actuator") || combined.includes("valve") ||
    combined.includes("pid") || combined.includes("recipe")
  ) {
    return Quadrant.Control;
  }

  // Alarm / event domain
  if (
    combined.includes("alarm") || combined.includes("alert") ||
    combined.includes("fault") || combined.includes("trip") ||
    combined.includes("deviation") || combined.includes("anomaly") ||
    combined.includes("event") || combined.includes("incident")
  ) {
    return Quadrant.Alarm;
  }

  // Maintenance domain
  if (
    combined.includes("maintenance") || combined.includes("calibration") ||
    combined.includes("inspection") || combined.includes("work_order") ||
    combined.includes("compliance") || combined.includes("certification") ||
    combined.includes("audit") || combined.includes("repair")
  ) {
    return Quadrant.Maintenance;
  }

  // Fallback: hash to quadrant
  return (contentHash(t) % 4) as Quadrant;
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
  const l = contentHash(`${entityId}:${entityType}`) % 8;

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
