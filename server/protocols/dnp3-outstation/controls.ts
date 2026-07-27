/**
 * DNP3 Controls — SELECT / OPERATE / DIRECT-OPERATE
 * Issue #464: DNP3 Outstation Mode
 *
 * Implements the outstation side of IEEE 1815-2012 §4.4.2 (control operations)
 * for the two command object groups an RTU must support:
 *
 *   - g12v1  Control Relay Output Block (CROB)   -> binaryOutput points
 *   - g41v1..v4 Analog Output Block              -> analogOutput points
 *
 * Before this module existed, SELECT/OPERATE fell through to the "unsupported
 * function code" branch of the application handler: a master's control request
 * was answered with IIN2.0 and nothing was ever executed.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * A DNP3 control is the highest-privilege operation this codebase exposes: it
 * moves live plant state. The write path is therefore FAIL-CLOSED and OFF BY
 * DEFAULT. Two independent things must both be true before a single octet
 * reaches the tag layer:
 *
 *   1. `config.enabled` must be explicitly set true (default false), and
 *   2. a `Dnp3ControlSink` must be installed by the embedder.
 *
 * If either is missing the outstation is read-only: every control object is
 * echoed with CommandStatus NOT_SUPPORTED (4). It never silently accepts, and
 * it never reports SUCCESS for an operation it did not perform.
 *
 * ── Select-before-operate ────────────────────────────────────────────────────
 * A SELECT validates and ARMS a specific point+value set for
 * `selectTimeoutMs`; it does NOT touch the process. The following OPERATE must
 * match the armed request exactly — same objects, same values, and an
 * application sequence number exactly one greater than the SELECT's (IEEE 1815
 * §4.4.2.1) — or it is rejected with NO_SELECT. An expired arm that otherwise
 * matches is rejected with TIMEOUT. Either way the arm is consumed, so a
 * rejected OPERATE can never be retried against a stale selection.
 */

import { logWarn } from '../../logger';
import {
  CROB_CLEAR_MASK,
  CROB_OP_TYPE_MASK,
  CROB_QUEUE_MASK,
  CROB_TCC_MASK,
  CROB_TCC_SHIFT,
  DNP3_COMMAND_STATUS,
  DNP3_CONTROL_OP_TYPE,
  DNP3_CONTROL_TCC,
  DNP3_FUNCTION,
  DNP3_GROUP,
  DNP3_IIN,
  DNP3_VARIATION,
  type Dnp3CommandStatus,
} from './app-objects';
import type { ParsedObjectHeader, ParsedPrefixedObject, ParsedRequest } from './app-layer';
import { Dnp3PointMap } from './point-map';

/** Decoded g12v1 control-code + timing fields. */
export interface CrobFields {
  /** operation type (low nibble of the control code) */
  opType: number;
  /** trip-close code (bits 6-7 of the control code) */
  tcc: number;
  /** "clear the operation running on this point" bit */
  clear: boolean;
  /** deprecated queue bit */
  queue: boolean;
  /** number of times to execute; 0 means "do not execute" */
  count: number;
  onTimeMs: number;
  offTimeMs: number;
}

/** Size in octets of each supported command object (including its status octet). */
export const CROB_OBJECT_SIZE = 11;

/** Octet size of a g41 Analog Output Block variation, or null if unsupported. */
export function analogOutputObjectSize(variation: number): number | null {
  switch (variation) {
    case DNP3_VARIATION.AO_CMD_INT32:
      return 5; // int32 + status
    case DNP3_VARIATION.AO_CMD_INT16:
      return 3; // int16 + status
    case DNP3_VARIATION.AO_CMD_FLOAT32:
      return 5; // float32 + status
    case DNP3_VARIATION.AO_CMD_DOUBLE64:
      return 9; // float64 + status
    default:
      return null;
  }
}

/**
 * Octet size of a command object for a group/variation pair, or null when the
 * outstation does not model it. Used by the request parser to length-decode
 * index-prefixed control objects.
 */
export function commandObjectSize(group: number, variation: number): number | null {
  if (group === DNP3_GROUP.BINARY_OUTPUT_COMMAND && variation === DNP3_VARIATION.CROB) {
    return CROB_OBJECT_SIZE;
  }
  if (group === DNP3_GROUP.ANALOG_OUTPUT_COMMAND) {
    return analogOutputObjectSize(variation);
  }
  return null;
}

/** Whether an object group carries control commands. */
export function isControlGroup(group: number): boolean {
  return group === DNP3_GROUP.BINARY_OUTPUT_COMMAND || group === DNP3_GROUP.ANALOG_OUTPUT_COMMAND;
}

/** Decode an 11-octet g12v1 CROB body. Returns null if the length is wrong. */
export function decodeCrob(data: Buffer): CrobFields | null {
  if (data.length !== CROB_OBJECT_SIZE) return null;
  const controlCode = data.readUInt8(0);
  return {
    opType: controlCode & CROB_OP_TYPE_MASK,
    tcc: (controlCode & CROB_TCC_MASK) >>> CROB_TCC_SHIFT,
    clear: (controlCode & CROB_CLEAR_MASK) !== 0,
    queue: (controlCode & CROB_QUEUE_MASK) !== 0,
    count: data.readUInt8(1),
    onTimeMs: data.readUInt32LE(2),
    offTimeMs: data.readUInt32LE(6),
  };
}

/** Re-encode a CROB body with the given command status in its status octet. */
export function encodeCrob(fields: CrobFields, status: number): Buffer {
  const buf = Buffer.alloc(CROB_OBJECT_SIZE);
  let controlCode = fields.opType & CROB_OP_TYPE_MASK;
  controlCode |= (fields.tcc << CROB_TCC_SHIFT) & CROB_TCC_MASK;
  if (fields.clear) controlCode |= CROB_CLEAR_MASK;
  if (fields.queue) controlCode |= CROB_QUEUE_MASK;
  buf.writeUInt8(controlCode, 0);
  buf.writeUInt8(fields.count & 0xff, 1);
  buf.writeUInt32LE(fields.onTimeMs >>> 0, 2);
  buf.writeUInt32LE(fields.offTimeMs >>> 0, 6);
  buf.writeUInt8(status & 0xff, 10);
  return buf;
}

/** Decode the commanded value of a g41 Analog Output Block. */
export function decodeAnalogOutput(variation: number, data: Buffer): number | null {
  const size = analogOutputObjectSize(variation);
  if (size === null || data.length !== size) return null;
  switch (variation) {
    case DNP3_VARIATION.AO_CMD_INT32:
      return data.readInt32LE(0);
    case DNP3_VARIATION.AO_CMD_INT16:
      return data.readInt16LE(0);
    case DNP3_VARIATION.AO_CMD_FLOAT32:
      return data.readFloatLE(0);
    case DNP3_VARIATION.AO_CMD_DOUBLE64:
      return data.readDoubleLE(0);
    default:
      return null;
  }
}

/** Re-encode a g41 Analog Output Block with the given command status. */
export function encodeAnalogOutput(variation: number, value: number, status: number): Buffer {
  const size = analogOutputObjectSize(variation);
  if (size === null) throw new Error(`Unsupported g41 variation ${variation}`);
  const buf = Buffer.alloc(size);
  switch (variation) {
    case DNP3_VARIATION.AO_CMD_INT32:
      buf.writeInt32LE(clampInt(value, -2147483648, 2147483647), 0);
      break;
    case DNP3_VARIATION.AO_CMD_INT16:
      buf.writeInt16LE(clampInt(value, -32768, 32767), 0);
      break;
    case DNP3_VARIATION.AO_CMD_FLOAT32:
      buf.writeFloatLE(value, 0);
      break;
    case DNP3_VARIATION.AO_CMD_DOUBLE64:
      buf.writeDoubleLE(value, 0);
      break;
  }
  buf.writeUInt8(status & 0xff, size - 1);
  return buf;
}

function clampInt(value: number, min: number, max: number): number {
  const v = Math.trunc(value);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * A control the outstation is asking the embedder to perform, already resolved
 * from a DNP3 point index to the 0xSCADA tag that backs it.
 */
export type Dnp3ControlCommand =
  | {
      kind: 'binaryOutput';
      group: number;
      variation: number;
      index: number;
      /** 0xSCADA tag id the DNP3 point maps to */
      tagId: string;
      /** commanded coil state */
      value: boolean;
      crob: CrobFields;
    }
  | {
      kind: 'analogOutput';
      group: number;
      variation: number;
      index: number;
      tagId: string;
      value: number;
    };

/** Result the embedder returns for one control. */
export type Dnp3ControlOutcome =
  | { ok: true }
  | { ok: false; status?: Dnp3CommandStatus };

/**
 * The seam through which controls reach live plant state. Synchronous by
 * design: DNP3 requires a CommandStatus in the OPERATE response, so a sink that
 * talks to slow hardware must enqueue the write and answer for the enqueue —
 * it must not report `ok` for something it has not at least durably accepted.
 */
export type Dnp3ControlSink = (command: Dnp3ControlCommand) => Dnp3ControlOutcome;

export interface Dnp3ControlConfig {
  /**
   * Master switch for the DNP3 write path. FALSE BY DEFAULT: an outstation is
   * read-only until an operator explicitly opts in.
   */
  enabled: boolean;
  /** How long a SELECT stays armed before an OPERATE is rejected with TIMEOUT. */
  selectTimeoutMs: number;
}

export const DEFAULT_CONTROL_CONFIG: Dnp3ControlConfig = {
  enabled: false,
  selectTimeoutMs: 5000,
};

/** An armed SELECT awaiting its matching OPERATE. */
export interface ArmedSelect {
  /** application sequence number of the SELECT request */
  seq: number;
  /** epoch ms at which the SELECT was accepted */
  armedAt: number;
  /** canonical object bytes (status octets zeroed) the OPERATE must reproduce */
  digest: Buffer;
  /** commands to run when a matching OPERATE arrives */
  commands: Dnp3ControlCommand[];
}

export interface ControlProcessResult {
  /** echoed control objects, ready to append after the application header */
  objects: Buffer;
  /** IIN bits to OR into the response header */
  iin: number;
  /** per-object command status, in request order */
  statuses: number[];
  /** commands actually handed to the sink */
  executed: Dnp3ControlCommand[];
}

/** One control object of a request, decoded as far as it could be. */
interface DecodedObject {
  header: ParsedObjectHeader;
  item: ParsedPrefixedObject;
  /** null when the object body could not be decoded */
  command: Dnp3ControlCommand | null;
  /** status determined during validation, or null when the object is valid */
  rejection: number | null;
  /** IIN bits this object contributes */
  iin: number;
}

/**
 * Owns the control state machine: the armed SELECT and the set of outputs with
 * an operation still running (used for ALREADY_ACTIVE).
 */
export class Dnp3ControlProcessor {
  private armed: ArmedSelect | null = null;
  /** binaryOutput index -> epoch ms until which its pulse is still running */
  private activeUntil = new Map<number, number>();

  constructor(
    private readonly pointMap: Dnp3PointMap,
    private readonly config: Dnp3ControlConfig = DEFAULT_CONTROL_CONFIG,
    private sink: Dnp3ControlSink | null = null,
  ) {}

  /** Install (or remove) the write seam. */
  setSink(sink: Dnp3ControlSink | null): void {
    this.sink = sink;
  }

  /** Whether the write path can actually reach plant state right now. */
  get writable(): boolean {
    return this.config.enabled && this.sink !== null;
  }

  /** Currently armed SELECT (diagnostics/tests). */
  get armedSelect(): ArmedSelect | null {
    return this.armed;
  }

  /** Drop any armed SELECT (e.g. on restart or link loss). */
  disarm(): void {
    this.armed = null;
  }

  /**
   * Process a SELECT / OPERATE / DIRECT_OPERATE(_NR) request and produce the
   * echoed objects plus per-object CommandStatus.
   */
  process(req: ParsedRequest, now: number): ControlProcessResult {
    const controlHeaders = req.objects.filter((o) => isControlGroup(o.group));
    if (controlHeaders.length === 0) {
      // A control function code with no control objects is a parameter error.
      return { objects: Buffer.alloc(0), iin: DNP3_IIN.PARAMETER_ERROR, statuses: [], executed: [] };
    }

    const decoded: DecodedObject[] = [];
    let iin = 0;
    for (const header of controlHeaders) {
      if (!header.items) {
        // The object header used a qualifier/variation whose object length we
        // could not decode — we must not guess at control bytes.
        iin |= DNP3_IIN.PARAMETER_ERROR;
        continue;
      }
      for (const item of header.items) {
        const d = this.decodeObject(header, item);
        iin |= d.iin;
        decoded.push(d);
      }
    }

    if (decoded.length === 0) {
      return { objects: Buffer.alloc(0), iin, statuses: [], executed: [] };
    }

    const statuses = this.resolveStatuses(req, decoded, now);
    const executed = decoded
      .map((d, i) => (statuses[i] === DNP3_COMMAND_STATUS.SUCCESS && d.command ? d.command : null))
      .filter((c): c is Dnp3ControlCommand => c !== null);

    return {
      objects: this.echo(controlHeaders, decoded, statuses),
      iin,
      statuses,
      executed: req.func === DNP3_FUNCTION.SELECT ? [] : executed,
    };
  }

  /** Decode + statically validate one control object. */
  private decodeObject(header: ParsedObjectHeader, item: ParsedPrefixedObject): DecodedObject {
    const base = { header, item };

    if (header.group === DNP3_GROUP.BINARY_OUTPUT_COMMAND) {
      const crob = decodeCrob(item.data);
      if (!crob) {
        return { ...base, command: null, rejection: DNP3_COMMAND_STATUS.FORMAT_ERROR, iin: DNP3_IIN.PARAMETER_ERROR };
      }
      // The queue bit is deprecated by IEEE 1815-2012 and the clear bit asks us
      // to cancel a running operation; neither is modelled, so say so rather
      // than executing something subtly different from what was asked.
      if (crob.queue || crob.clear) {
        return { ...base, command: null, rejection: DNP3_COMMAND_STATUS.NOT_SUPPORTED, iin: 0 };
      }
      const value = crobValue(crob);
      if (value === null) {
        return { ...base, command: null, rejection: DNP3_COMMAND_STATUS.NOT_SUPPORTED, iin: 0 };
      }
      const def = this.pointMap.getPoint('binaryOutput', item.index);
      if (!def) {
        return { ...base, command: null, rejection: DNP3_COMMAND_STATUS.NOT_SUPPORTED, iin: DNP3_IIN.OBJECT_UNKNOWN };
      }
      return {
        ...base,
        command: {
          kind: 'binaryOutput',
          group: header.group,
          variation: header.variation,
          index: item.index,
          tagId: def.tagId,
          value,
          crob,
        },
        rejection: null,
        iin: 0,
      };
    }

    // Analog Output Block (group 41).
    const value = decodeAnalogOutput(header.variation, item.data);
    if (value === null) {
      const known = analogOutputObjectSize(header.variation) !== null;
      return {
        ...base,
        command: null,
        // A known variation with the wrong length is a format error; an unknown
        // variation is simply not supported.
        rejection: known ? DNP3_COMMAND_STATUS.FORMAT_ERROR : DNP3_COMMAND_STATUS.NOT_SUPPORTED,
        iin: known ? DNP3_IIN.PARAMETER_ERROR : DNP3_IIN.OBJECT_UNKNOWN,
      };
    }
    const def = this.pointMap.getPoint('analogOutput', item.index);
    if (!def) {
      return { ...base, command: null, rejection: DNP3_COMMAND_STATUS.NOT_SUPPORTED, iin: DNP3_IIN.OBJECT_UNKNOWN };
    }
    return {
      ...base,
      command: {
        kind: 'analogOutput',
        group: header.group,
        variation: header.variation,
        index: item.index,
        tagId: def.tagId,
        value,
      },
      rejection: null,
      iin: 0,
    };
  }

  /** Apply the function-code semantics and produce one status per object. */
  private resolveStatuses(req: ParsedRequest, decoded: DecodedObject[], now: number): number[] {
    // ── Fail-closed gate ─────────────────────────────────────────────────────
    // Nothing below this point may run unless controls are explicitly enabled
    // AND a sink exists. A read-only outstation answers NOT_SUPPORTED.
    if (!this.writable) {
      logWarn(
        this.config.enabled
          ? 'DNP3 outstation: control rejected — controls enabled but no control sink installed'
          : 'DNP3 outstation: control rejected — controls are disabled (read-only outstation)',
      );
      this.armed = null;
      return decoded.map(() => DNP3_COMMAND_STATUS.NOT_SUPPORTED);
    }

    const invalid = decoded.map((d) => d.rejection);

    if (req.func === DNP3_FUNCTION.SELECT) {
      // A SELECT never touches the process. Arm only when every object is valid.
      if (invalid.some((r) => r !== null)) {
        this.armed = null;
        return invalid.map((r) => r ?? DNP3_COMMAND_STATUS.SUCCESS);
      }
      const commands = decoded.map((d) => d.command!);
      this.armed = {
        seq: req.seq,
        armedAt: now,
        digest: canonicalDigest(decoded),
        commands,
      };
      return decoded.map(() => DNP3_COMMAND_STATUS.SUCCESS);
    }

    if (req.func === DNP3_FUNCTION.OPERATE) {
      const armed = this.armed;
      // The arm is single-use: consume it whatever the outcome, so a rejected
      // OPERATE can never be replayed against a stale selection.
      this.armed = null;
      if (!armed) {
        return decoded.map(() => DNP3_COMMAND_STATUS.NO_SELECT);
      }
      const matches =
        armed.seq === ((req.seq - 1 + 16) & 0x0f) &&
        armed.digest.equals(canonicalDigest(decoded));
      if (!matches) {
        return decoded.map(() => DNP3_COMMAND_STATUS.NO_SELECT);
      }
      if (now - armed.armedAt > this.config.selectTimeoutMs) {
        return decoded.map(() => DNP3_COMMAND_STATUS.TIMEOUT);
      }
      return this.execute(decoded, invalid, now);
    }

    // DIRECT_OPERATE / DIRECT_OPERATE_NR: no prior SELECT required. Any armed
    // selection is invalidated because the point state may now differ.
    this.armed = null;
    return this.execute(decoded, invalid, now);
  }

  /** Run the valid commands through the sink and collect their statuses. */
  private execute(decoded: DecodedObject[], invalid: (number | null)[], now: number): number[] {
    const sink = this.sink;
    if (!sink) return decoded.map(() => DNP3_COMMAND_STATUS.NOT_SUPPORTED);

    return decoded.map((d, i) => {
      const rejection = invalid[i];
      if (rejection !== null) return rejection;
      const command = d.command!;

      if (command.kind === 'binaryOutput') {
        // IEEE 1815 g12v1: a count of 0 means the outstation shall NOT execute
        // the operation. That is a well-formed no-op, not an error.
        if (command.crob.count === 0) return DNP3_COMMAND_STATUS.SUCCESS;
        const busyUntil = this.activeUntil.get(command.index);
        if (busyUntil !== undefined && busyUntil > now) {
          return DNP3_COMMAND_STATUS.ALREADY_ACTIVE;
        }
      }

      let outcome: Dnp3ControlOutcome;
      try {
        outcome = sink(command);
      } catch {
        // A throwing sink is a hardware/integration failure, not a protocol one.
        return DNP3_COMMAND_STATUS.HARDWARE_ERROR;
      }
      if (!outcome.ok) {
        return outcome.status ?? DNP3_COMMAND_STATUS.HARDWARE_ERROR;
      }

      if (command.kind === 'binaryOutput') {
        const duration = pulseDurationMs(command.crob);
        if (duration > 0) this.activeUntil.set(command.index, now + duration);
        else this.activeUntil.delete(command.index);
      }
      return DNP3_COMMAND_STATUS.SUCCESS;
    });
  }

  /** Rebuild the request's object headers with per-object status octets. */
  private echo(headers: ParsedObjectHeader[], decoded: DecodedObject[], statuses: number[]): Buffer {
    const parts: Buffer[] = [];
    let cursor = 0;
    for (const header of headers) {
      if (!header.items || header.items.length === 0) continue;
      const twoOctet = (header.qualifier & 0xf0) === 0x20;
      const prefixLen = twoOctet ? 2 : 1;
      const countLen = twoOctet ? 2 : 1;

      const objHeader = Buffer.alloc(3 + countLen);
      objHeader.writeUInt8(header.group, 0);
      objHeader.writeUInt8(header.variation, 1);
      objHeader.writeUInt8(header.qualifier, 2);
      if (twoOctet) objHeader.writeUInt16LE(header.items.length, 3);
      else objHeader.writeUInt8(header.items.length, 3);
      parts.push(objHeader);

      for (const item of header.items) {
        const d = decoded[cursor];
        const status = statuses[cursor] ?? DNP3_COMMAND_STATUS.UNDEFINED;
        cursor += 1;
        const prefix = Buffer.alloc(prefixLen);
        if (twoOctet) prefix.writeUInt16LE(item.index, 0);
        else prefix.writeUInt8(item.index, 0);
        parts.push(prefix, echoBody(header, item, d, status));
      }
    }
    return Buffer.concat(parts);
  }
}

/**
 * Echo one command object with its status octet replaced. When the body could
 * not be decoded we echo the master's own octets back verbatim except for the
 * final status octet, which is what IEEE 1815 asks for.
 */
function echoBody(
  header: ParsedObjectHeader,
  item: ParsedPrefixedObject,
  decoded: DecodedObject | undefined,
  status: number,
): Buffer {
  if (decoded?.command) {
    if (decoded.command.kind === 'binaryOutput') {
      return encodeCrob(decoded.command.crob, status);
    }
    return encodeAnalogOutput(header.variation, decoded.command.value, status);
  }
  if (item.data.length === 0) return Buffer.alloc(0);
  const copy = Buffer.from(item.data);
  copy.writeUInt8(status & 0xff, copy.length - 1);
  return copy;
}

/**
 * The commanded coil state of a CROB, or null when the operation type is not
 * one this outstation performs. The Trip-Close Code selects the physical coil
 * on a paired output and therefore overrides the operation-type polarity.
 */
export function crobValue(crob: CrobFields): boolean | null {
  let value: boolean;
  switch (crob.opType) {
    case DNP3_CONTROL_OP_TYPE.LATCH_ON:
    case DNP3_CONTROL_OP_TYPE.PULSE_ON:
      value = true;
      break;
    case DNP3_CONTROL_OP_TYPE.LATCH_OFF:
    case DNP3_CONTROL_OP_TYPE.PULSE_OFF:
      value = false;
      break;
    default:
      // NUL and reserved operation types are not executed.
      return null;
  }
  if (crob.tcc === DNP3_CONTROL_TCC.TRIP) return false;
  if (crob.tcc === DNP3_CONTROL_TCC.CLOSE) return true;
  return value;
}

/**
 * How long a CROB keeps the output busy, in ms. Latch operations complete
 * immediately; pulse trains are busy for `count` on-periods plus the
 * intervening off-periods. A later OPERATE arriving inside that window is
 * rejected with ALREADY_ACTIVE.
 */
export function pulseDurationMs(crob: CrobFields): number {
  if (crob.opType !== DNP3_CONTROL_OP_TYPE.PULSE_ON && crob.opType !== DNP3_CONTROL_OP_TYPE.PULSE_OFF) {
    return 0;
  }
  const count = Math.max(0, crob.count);
  if (count === 0) return 0;
  return count * crob.onTimeMs + (count - 1) * crob.offTimeMs;
}

/**
 * Canonical bytes an OPERATE must reproduce to match its SELECT: group,
 * variation, index and the full object body with the status octet zeroed (the
 * master sends status 0 in requests, but zeroing makes the comparison immune to
 * a master that echoes something else).
 */
function canonicalDigest(decoded: DecodedObject[]): Buffer {
  const parts: Buffer[] = [];
  for (const d of decoded) {
    const head = Buffer.alloc(4);
    head.writeUInt8(d.header.group, 0);
    head.writeUInt8(d.header.variation, 1);
    head.writeUInt16LE(d.item.index & 0xffff, 2);
    const body = Buffer.from(d.item.data);
    if (body.length > 0) body.writeUInt8(0, body.length - 1);
    parts.push(head, body);
  }
  return Buffer.concat(parts);
}
