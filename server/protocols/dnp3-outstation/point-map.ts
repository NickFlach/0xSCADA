/**
 * DNP3 Point Map — Tag -> DNP3 Point Mapping
 * Issue #464: DNP3 Outstation Mode
 *
 * FULLY IMPLEMENTED + UNIT TESTED.
 *
 * The point map is the bridge between 0xSCADA tags (string-addressed,
 * quality-tagged values) and the flat, group-indexed DNP3 static database that
 * a master polls. Each of the five DNP3 static groups is its own contiguous
 * index space (0..N-1):
 *
 *   - Binary Inputs    (group 1)   — read-only boolean
 *   - Analog Inputs    (group 30)  — read-only numeric
 *   - Counters         (group 20)  — read-only monotonic numeric
 *   - Binary Outputs   (group 10)  — read/write boolean (status)
 *   - Analog Outputs   (group 40)  — read/write numeric (status)
 *
 * This module owns: the mapping registry, value normalisation, status-flag
 * derivation, and serialisation of a static point to its DNP3 wire octets.
 * It does NOT open sockets or assemble APDUs (see index.ts).
 */

import { z } from 'zod';
import {
  DNP3_GROUP,
  DNP3_VARIATION,
  buildAnalogFlags,
  buildBinaryFlags,
  qualityToFlags,
  encodeAnalog32WithFlag,
  encodeAnalogFloatWithFlag,
  encodeCounter32WithFlag,
  encodeBinaryWithFlag,
  type PointQuality,
  type FlagOptions,
} from './app-objects';

/** The five DNP3 static point classes this outstation exposes. */
export type Dnp3PointType =
  | 'binaryInput'
  | 'analogInput'
  | 'counter'
  | 'binaryOutput'
  | 'analogOutput';

/** Numeric analog encodings supported per point. */
export type AnalogEncoding = 'int32' | 'float32';

/**
 * Static definition of a single DNP3 point and the 0xSCADA tag feeding it.
 * `index` is the DNP3 point index WITHIN its group (0-based, contiguous).
 */
export interface Dnp3PointDef {
  /** 0xSCADA tag id / address that supplies this point's value. */
  tagId: string;
  /** DNP3 static group/type. */
  type: Dnp3PointType;
  /** 0-based DNP3 point index within the group. */
  index: number;
  /** Human-readable description (optional, for diagnostics). */
  description?: string;
  /** DNP3 event class this point belongs to (0 = static only / no events). */
  eventClass?: 0 | 1 | 2 | 3;
  /** Analog encoding (analog in/out only). Defaults to float32. */
  encoding?: AnalogEncoding;
  /** Deadband: analog event only fires when |new-last| >= deadband. */
  deadband?: number;
  /** Scale factor applied to the raw tag value before mapping (default 1). */
  scale?: number;
}

export const Dnp3PointDefSchema = z.object({
  tagId: z.string().min(1),
  type: z.enum(['binaryInput', 'analogInput', 'counter', 'binaryOutput', 'analogOutput']),
  index: z.number().int().nonnegative(),
  description: z.string().optional(),
  eventClass: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  encoding: z.enum(['int32', 'float32']).optional(),
  deadband: z.number().nonnegative().optional(),
  scale: z.number().optional(),
});

export const Dnp3PointMapConfigSchema = z.object({
  points: z.array(Dnp3PointDefSchema),
});
export type Dnp3PointMapConfig = z.infer<typeof Dnp3PointMapConfigSchema>;

/** A live point value plus its quality, as ingested from the tag layer. */
export interface PointSample {
  value: number | boolean;
  quality: PointQuality;
  timestamp: number; // epoch ms
}

/** A point's current static value, ready for serialisation. */
export interface ResolvedPoint {
  def: Dnp3PointDef;
  sample: PointSample;
}

/** Group/variation pair selected for a static read of a point. */
export interface PointGroupVariation {
  group: number;
  variation: number;
}

/**
 * The DNP3 point map. Maintains the per-group index space, current values, and
 * the reverse tag->point lookup used when tag updates arrive.
 */
export class Dnp3PointMap {
  /** points keyed by `${type}:${index}` */
  private points = new Map<string, Dnp3PointDef>();
  /** reverse index: tagId -> list of point keys (a tag may feed >1 point) */
  private byTag = new Map<string, string[]>();
  /** current sampled value per point key */
  private values = new Map<string, PointSample>();

  constructor(config?: Dnp3PointMapConfig) {
    if (config) {
      for (const def of config.points) this.addPoint(def);
    }
  }

  /** Stable map key for a point. */
  static key(type: Dnp3PointType, index: number): string {
    return `${type}:${index}`;
  }

  /** Register a point. Throws on a duplicate (type,index). */
  addPoint(def: Dnp3PointDef): void {
    const parsed = Dnp3PointDefSchema.parse(def);
    const key = Dnp3PointMap.key(parsed.type, parsed.index);
    if (this.points.has(key)) {
      throw new Error(`DNP3 point already mapped: ${key}`);
    }
    this.points.set(key, parsed);
    const list = this.byTag.get(parsed.tagId) ?? [];
    list.push(key);
    this.byTag.set(parsed.tagId, list);
    // Seed with offline/bad value until first sample arrives.
    this.values.set(key, { value: parsed.type === 'binaryInput' || parsed.type === 'binaryOutput' ? false : 0, quality: 'bad', timestamp: 0 });
  }

  /** All points of a given type, sorted by index (group ordering for reads). */
  pointsOfType(type: Dnp3PointType): Dnp3PointDef[] {
    return [...this.points.values()]
      .filter((p) => p.type === type)
      .sort((a, b) => a.index - b.index);
  }

  /** Number of points of a given type. */
  count(type: Dnp3PointType): number {
    return this.pointsOfType(type).length;
  }

  /** Look up a point by type/index. */
  getPoint(type: Dnp3PointType, index: number): Dnp3PointDef | undefined {
    return this.points.get(Dnp3PointMap.key(type, index));
  }

  /**
   * Apply a tag update. Returns the point keys whose value changed so the
   * caller can decide whether to enqueue events. Quality is normalised; analog
   * values are scaled.
   */
  applyTagUpdate(tagId: string, sample: PointSample): string[] {
    const keys = this.byTag.get(tagId);
    if (!keys) return [];
    const changed: string[] = [];
    for (const key of keys) {
      const def = this.points.get(key)!;
      const normalised = this.normalise(def, sample);
      this.values.set(key, normalised);
      changed.push(key);
    }
    return changed;
  }

  /** Current sample for a point key (always defined for a registered point). */
  getSample(key: string): PointSample | undefined {
    return this.values.get(key);
  }

  /** Resolve a point to its def+sample. */
  resolve(type: Dnp3PointType, index: number): ResolvedPoint | undefined {
    const key = Dnp3PointMap.key(type, index);
    const def = this.points.get(key);
    const sample = this.values.get(key);
    if (!def || !sample) return undefined;
    return { def, sample };
  }

  /**
   * Normalise a raw tag sample for a point: apply scale to numerics, coerce
   * types so a boolean tag feeding an analog point still produces a number.
   */
  private normalise(def: Dnp3PointDef, sample: PointSample): PointSample {
    const scale = def.scale ?? 1;
    let value: number | boolean = sample.value;
    if (def.type === 'binaryInput' || def.type === 'binaryOutput') {
      value = typeof value === 'boolean' ? value : Number(value) !== 0;
    } else {
      const num = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
      value = (Number.isFinite(num) ? num : 0) * scale;
    }
    return { value, quality: sample.quality, timestamp: sample.timestamp };
  }
}

/**
 * Determine the default static group/variation for a point type + encoding.
 * Binary types use flag variations; analog types pick int32 vs float32.
 */
export function defaultGroupVariation(def: Dnp3PointDef): PointGroupVariation {
  switch (def.type) {
    case 'binaryInput':
      return { group: DNP3_GROUP.BINARY_INPUT_STATIC, variation: DNP3_VARIATION.BI_WITH_FLAGS };
    case 'binaryOutput':
      return { group: DNP3_GROUP.BINARY_OUTPUT_STATIC, variation: DNP3_VARIATION.BO_STATUS_WITH_FLAGS };
    case 'counter':
      return { group: DNP3_GROUP.COUNTER_STATIC, variation: DNP3_VARIATION.CNT_32_WITH_FLAG };
    case 'analogInput':
      return def.encoding === 'int32'
        ? { group: DNP3_GROUP.ANALOG_INPUT_STATIC, variation: DNP3_VARIATION.AI_32_WITH_FLAG }
        : { group: DNP3_GROUP.ANALOG_INPUT_STATIC, variation: DNP3_VARIATION.AI_FLOAT_WITH_FLAG };
    case 'analogOutput':
      return def.encoding === 'int32'
        ? { group: DNP3_GROUP.ANALOG_OUTPUT_STATUS, variation: DNP3_VARIATION.AO_STATUS_32_WITH_FLAG }
        : { group: DNP3_GROUP.ANALOG_OUTPUT_STATUS, variation: DNP3_VARIATION.AO_STATUS_FLOAT_WITH_FLAG };
  }
}

/**
 * Derive the DNP3 flag octet for a resolved point from its quality + value.
 * For binary points the actual state is carried in flag bit 7.
 */
export function deriveFlags(point: ResolvedPoint): number {
  const isBinary = point.def.type === 'binaryInput' || point.def.type === 'binaryOutput';
  const state = isBinary ? Boolean(point.sample.value) : undefined;
  const opts: FlagOptions = qualityToFlags(point.sample.quality, state);
  return isBinary ? buildBinaryFlags(opts) : buildAnalogFlags(opts);
}

/**
 * Serialise a single resolved static point to its DNP3 object octets
 * (flag + value, little-endian). The group/variation chosen is the default for
 * the point. Returns both the octets and the chosen group/variation so the APDU
 * assembler can emit the matching object header.
 */
export function serializeStaticPoint(point: ResolvedPoint): {
  groupVariation: PointGroupVariation;
  data: Buffer;
} {
  const gv = defaultGroupVariation(point.def);
  const flags = deriveFlags(point);
  const { type, encoding } = point.def;
  const value = point.sample.value;

  let data: Buffer;
  switch (type) {
    case 'binaryInput':
    case 'binaryOutput':
      data = encodeBinaryWithFlag(flags);
      break;
    case 'counter':
      data = encodeCounter32WithFlag(Number(value), flags);
      break;
    case 'analogInput':
    case 'analogOutput':
      data = encoding === 'int32'
        ? encodeAnalog32WithFlag(Number(value), flags)
        : encodeAnalogFloatWithFlag(Number(value), flags);
      break;
  }
  return { groupVariation: gv, data };
}
