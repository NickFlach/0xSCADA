/**
 * Tests for DNP3 SELECT / OPERATE / DIRECT-OPERATE (#464).
 *
 * Covers the g12v1 CROB and g41 Analog Output Block codecs against hand-derived
 * byte vectors, the select-before-operate state machine, and — most importantly
 * — that the write path stays fail-closed unless it is explicitly turned on.
 */
import { describe, test, expect, vi } from 'vitest';
import {
  Dnp3ControlProcessor,
  decodeCrob,
  encodeCrob,
  decodeAnalogOutput,
  encodeAnalogOutput,
  commandObjectSize,
  crobValue,
  pulseDurationMs,
  type CrobFields,
  type Dnp3ControlCommand,
  type Dnp3ControlSink,
} from '../controls';
import { parseRequest } from '../app-layer';
import { Dnp3PointMap } from '../point-map';
import {
  DNP3_COMMAND_STATUS,
  DNP3_CONTROL_OP_TYPE,
  DNP3_CONTROL_TCC,
  DNP3_FUNCTION,
  DNP3_IIN,
} from '../app-objects';

/**
 * A real master's OPERATE of a CROB, octet by octet:
 *   C1                FIR|FIN, sequence 1
 *   04                OPERATE
 *   0C 01             group 12 variation 1 (CROB)
 *   17                qualifier: 1-octet index prefix + 1-octet count
 *   01                count = 1
 *   00                index prefix = point 0
 *   41                control code 0b0100_0001 = TCC CLOSE(1), op type PULSE_ON(1)
 *   01                count = 1 execution
 *   E8 03 00 00       on-time  = 1000 ms
 *   D0 07 00 00       off-time = 2000 ms
 *   00                status octet (always 0 in a request)
 */
const OPERATE_CROB = Buffer.from([
  0xc1, 0x04, 0x0c, 0x01, 0x17, 0x01, 0x00,
  0x41, 0x01, 0xe8, 0x03, 0x00, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00,
]);

/** The same objects under function code 0x03 SELECT, sequence 0. */
const SELECT_CROB = Buffer.from([
  0xc0, 0x03, 0x0c, 0x01, 0x17, 0x01, 0x00,
  0x41, 0x01, 0xe8, 0x03, 0x00, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00,
]);

/**
 * DIRECT_OPERATE of a g41v1 Analog Output Block:
 *   C2 05          FIR|FIN seq 2, DIRECT_OPERATE
 *   29 01          group 41 (0x29) variation 1 (32-bit signed)
 *   17 01 02       qualifier 0x17, count 1, index 2
 *   E8 03 00 00    value = 1000
 *   00             status octet
 */
const DIRECT_OPERATE_AO = Buffer.from([
  0xc2, 0x05, 0x29, 0x01, 0x17, 0x01, 0x02, 0xe8, 0x03, 0x00, 0x00, 0x00,
]);

function makeMap(): Dnp3PointMap {
  return new Dnp3PointMap({
    points: [
      { tagId: 'valve.cmd', type: 'binaryOutput', index: 0 },
      { tagId: 'pump.cmd', type: 'binaryOutput', index: 1 },
      { tagId: 'setpoint', type: 'analogOutput', index: 2, encoding: 'int32' },
    ],
  });
}

interface Harness {
  processor: Dnp3ControlProcessor;
  calls: Dnp3ControlCommand[];
}

function harness(opts?: { enabled?: boolean; sink?: Dnp3ControlSink | null; selectTimeoutMs?: number }): Harness {
  const calls: Dnp3ControlCommand[] = [];
  const defaultSink: Dnp3ControlSink = (cmd) => {
    calls.push(cmd);
    return { ok: true };
  };
  const sink = opts?.sink === undefined ? defaultSink : opts.sink;
  const processor = new Dnp3ControlProcessor(
    makeMap(),
    { enabled: opts?.enabled ?? true, selectTimeoutMs: opts?.selectTimeoutMs ?? 5000 },
    sink,
  );
  return { processor, calls };
}

describe('g12v1 CROB codec', () => {
  test('decodes the golden OPERATE request', () => {
    const req = parseRequest(OPERATE_CROB);
    expect(req.func).toBe(DNP3_FUNCTION.OPERATE);
    expect(req.seq).toBe(1);
    expect(req.objects).toHaveLength(1);
    const header = req.objects[0];
    expect(header.group).toBe(12);
    expect(header.variation).toBe(1);
    expect(header.qualifier).toBe(0x17);
    expect(header.count).toBe(1);
    expect(header.items).toHaveLength(1);
    expect(header.items![0].index).toBe(0);

    const crob = decodeCrob(header.items![0].data);
    expect(crob).toEqual<CrobFields>({
      opType: DNP3_CONTROL_OP_TYPE.PULSE_ON,
      tcc: DNP3_CONTROL_TCC.CLOSE,
      clear: false,
      queue: false,
      count: 1,
      onTimeMs: 1000,
      offTimeMs: 2000,
    });
  });

  test('re-encodes to the same octets with the status field replaced', () => {
    const crob = decodeCrob(OPERATE_CROB.subarray(7))!;
    expect([...encodeCrob(crob, DNP3_COMMAND_STATUS.SUCCESS)]).toEqual([
      0x41, 0x01, 0xe8, 0x03, 0x00, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00,
    ]);
    expect(encodeCrob(crob, DNP3_COMMAND_STATUS.NOT_SUPPORTED)[10]).toBe(4);
  });

  test('rejects a body that is not exactly 11 octets', () => {
    expect(decodeCrob(Buffer.alloc(10))).toBeNull();
    expect(decodeCrob(Buffer.alloc(12))).toBeNull();
  });

  test('control code maps to a coil state, with TCC overriding polarity', () => {
    const base: CrobFields = { opType: 0, tcc: 0, clear: false, queue: false, count: 1, onTimeMs: 0, offTimeMs: 0 };
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.LATCH_ON })).toBe(true);
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.LATCH_OFF })).toBe(false);
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.PULSE_ON })).toBe(true);
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.PULSE_OFF })).toBe(false);
    // TCC selects the physical coil on a paired trip/close output.
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.PULSE_ON, tcc: DNP3_CONTROL_TCC.TRIP })).toBe(false);
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.PULSE_OFF, tcc: DNP3_CONTROL_TCC.CLOSE })).toBe(true);
    // NUL and reserved operation types are not executed at all.
    expect(crobValue({ ...base, opType: DNP3_CONTROL_OP_TYPE.NUL })).toBeNull();
    expect(crobValue({ ...base, opType: 9 })).toBeNull();
  });

  test('pulse duration covers the whole train; latches finish immediately', () => {
    const pulse: CrobFields = {
      opType: DNP3_CONTROL_OP_TYPE.PULSE_ON, tcc: 0, clear: false, queue: false,
      count: 3, onTimeMs: 100, offTimeMs: 50,
    };
    // 3 on-periods + 2 intervening off-periods.
    expect(pulseDurationMs(pulse)).toBe(3 * 100 + 2 * 50);
    expect(pulseDurationMs({ ...pulse, count: 1 })).toBe(100);
    expect(pulseDurationMs({ ...pulse, count: 0 })).toBe(0);
    expect(pulseDurationMs({ ...pulse, opType: DNP3_CONTROL_OP_TYPE.LATCH_ON })).toBe(0);
  });
});

describe('g41 Analog Output Block codec', () => {
  test('object sizes per variation', () => {
    expect(commandObjectSize(12, 1)).toBe(11); // CROB
    expect(commandObjectSize(41, 1)).toBe(5); // int32 + status
    expect(commandObjectSize(41, 2)).toBe(3); // int16 + status
    expect(commandObjectSize(41, 3)).toBe(5); // float32 + status
    expect(commandObjectSize(41, 4)).toBe(9); // float64 + status
    expect(commandObjectSize(41, 9)).toBeNull();
    expect(commandObjectSize(30, 1)).toBeNull();
  });

  test('decodes the golden DIRECT_OPERATE request', () => {
    const req = parseRequest(DIRECT_OPERATE_AO);
    expect(req.func).toBe(DNP3_FUNCTION.DIRECT_OPERATE);
    const header = req.objects[0];
    expect([header.group, header.variation, header.qualifier]).toEqual([41, 1, 0x17]);
    expect(header.items![0].index).toBe(2);
    expect(decodeAnalogOutput(1, header.items![0].data)).toBe(1000);
  });

  test('round-trips every supported variation', () => {
    expect(decodeAnalogOutput(1, encodeAnalogOutput(1, -70000, 0))).toBe(-70000);
    expect(decodeAnalogOutput(2, encodeAnalogOutput(2, -1234, 0))).toBe(-1234);
    expect(decodeAnalogOutput(3, encodeAnalogOutput(3, 1.5, 0))).toBeCloseTo(1.5);
    expect(decodeAnalogOutput(4, encodeAnalogOutput(4, 1e300, 0))).toBe(1e300);
    expect([...encodeAnalogOutput(1, 1000, DNP3_COMMAND_STATUS.SUCCESS)]).toEqual([0xe8, 0x03, 0x00, 0x00, 0x00]);
  });

  test('rejects a wrong-length body and an unknown variation', () => {
    expect(decodeAnalogOutput(1, Buffer.alloc(4))).toBeNull();
    expect(decodeAnalogOutput(9, Buffer.alloc(5))).toBeNull();
  });
});

describe('fail-closed write path', () => {
  test('controls disabled: every object is rejected with NOT_SUPPORTED and nothing executes', () => {
    const { processor, calls } = harness({ enabled: false });
    const result = processor.process(parseRequest(DIRECT_OPERATE_AO), 1000);
    expect(result.statuses).toEqual([DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
    expect(calls).toEqual([]);
    expect(result.executed).toEqual([]);
    expect(processor.writable).toBe(false);
    // The echoed object carries the rejection in its status octet.
    expect([...result.objects]).toEqual([
      0x29, 0x01, 0x17, 0x01, // g41 v1, qualifier 0x17, count 1
      0x02, // index 2
      0xe8, 0x03, 0x00, 0x00, // the value the master asked for, echoed back
      0x04, // CommandStatus NOT_SUPPORTED
    ]);
  });

  test('controls enabled but no sink installed still rejects', () => {
    const { processor } = harness({ enabled: true, sink: null });
    expect(processor.writable).toBe(false);
    const result = processor.process(parseRequest(DIRECT_OPERATE_AO), 1000);
    expect(result.statuses).toEqual([DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
  });

  test('a disabled outstation never arms a SELECT', () => {
    const { processor } = harness({ enabled: false });
    processor.process(parseRequest(SELECT_CROB), 1000);
    expect(processor.armedSelect).toBeNull();
  });

  test('installing a sink later makes the path writable', () => {
    const { processor } = harness({ enabled: true, sink: null });
    expect(processor.writable).toBe(false);
    processor.setSink(() => ({ ok: true }));
    expect(processor.writable).toBe(true);
  });
});

describe('select-before-operate', () => {
  test('happy path: SELECT arms without executing, OPERATE executes', () => {
    const { processor, calls } = harness();

    const select = processor.process(parseRequest(SELECT_CROB), 1000);
    expect(select.statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls).toEqual([]); // a SELECT must never touch plant state
    expect(processor.armedSelect).not.toBeNull();

    const operate = processor.process(parseRequest(OPERATE_CROB), 1500);
    expect(operate.statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'binaryOutput',
      index: 0,
      tagId: 'valve.cmd', // resolved through the point map, not invented
      value: true,
    });
    // The arm is consumed by the OPERATE.
    expect(processor.armedSelect).toBeNull();

    // Response echoes the request objects with SUCCESS in the status octet.
    expect([...operate.objects]).toEqual([
      0x0c, 0x01, 0x17, 0x01, 0x00,
      0x41, 0x01, 0xe8, 0x03, 0x00, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x00,
    ]);
  });

  test('OPERATE without a SELECT is rejected with NO_SELECT', () => {
    const { processor, calls } = harness();
    const operate = processor.process(parseRequest(OPERATE_CROB), 1000);
    expect(operate.statuses).toEqual([DNP3_COMMAND_STATUS.NO_SELECT]);
    expect(calls).toEqual([]);
    expect(operate.objects[operate.objects.length - 1]).toBe(DNP3_COMMAND_STATUS.NO_SELECT);
  });

  test('OPERATE after the select timeout is rejected with TIMEOUT', () => {
    const { processor, calls } = harness({ selectTimeoutMs: 5000 });
    processor.process(parseRequest(SELECT_CROB), 1000);
    const operate = processor.process(parseRequest(OPERATE_CROB), 1000 + 5001);
    expect(operate.statuses).toEqual([DNP3_COMMAND_STATUS.TIMEOUT]);
    expect(calls).toEqual([]);
    // Expiry consumes the arm: a prompt retry must not succeed either.
    expect(processor.armedSelect).toBeNull();
    expect(processor.process(parseRequest(OPERATE_CROB), 1000 + 5002).statuses)
      .toEqual([DNP3_COMMAND_STATUS.NO_SELECT]);
  });

  test('an OPERATE whose value differs from the SELECT is rejected', () => {
    const { processor, calls } = harness();
    processor.process(parseRequest(SELECT_CROB), 1000);
    // Same point, but LATCH_OFF (0x04) instead of the selected pulse-on/close.
    const tampered = Buffer.from(OPERATE_CROB);
    tampered[7] = 0x04;
    const operate = processor.process(parseRequest(tampered), 1100);
    expect(operate.statuses).toEqual([DNP3_COMMAND_STATUS.NO_SELECT]);
    expect(calls).toEqual([]);
  });

  test('an OPERATE for a different point than the SELECT is rejected', () => {
    const { processor, calls } = harness();
    processor.process(parseRequest(SELECT_CROB), 1000);
    const otherPoint = Buffer.from(OPERATE_CROB);
    otherPoint[6] = 0x01; // index 1 instead of 0
    expect(processor.process(parseRequest(otherPoint), 1100).statuses)
      .toEqual([DNP3_COMMAND_STATUS.NO_SELECT]);
    expect(calls).toEqual([]);
  });

  test('an OPERATE whose sequence number is not SELECT+1 is rejected', () => {
    const { processor, calls } = harness();
    processor.process(parseRequest(SELECT_CROB), 1000); // seq 0
    const wrongSeq = Buffer.from(OPERATE_CROB);
    wrongSeq[0] = 0xc5; // FIR|FIN, sequence 5 instead of 1
    expect(processor.process(parseRequest(wrongSeq), 1100).statuses)
      .toEqual([DNP3_COMMAND_STATUS.NO_SELECT]);
    expect(calls).toEqual([]);
  });

  test('sequence numbers wrap: SELECT at 15 is matched by OPERATE at 0', () => {
    const { processor, calls } = harness();
    const select = Buffer.from(SELECT_CROB);
    select[0] = 0xcf; // FIR|FIN, sequence 15
    const operate = Buffer.from(OPERATE_CROB);
    operate[0] = 0xc0; // FIR|FIN, sequence 0
    processor.process(parseRequest(select), 1000);
    expect(processor.process(parseRequest(operate), 1100).statuses)
      .toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls).toHaveLength(1);
  });

  test('DIRECT_OPERATE needs no SELECT and invalidates any armed one', () => {
    const { processor, calls } = harness();
    processor.process(parseRequest(SELECT_CROB), 1000);
    const direct = processor.process(parseRequest(DIRECT_OPERATE_AO), 1100);
    expect(direct.statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'analogOutput', index: 2, tagId: 'setpoint', value: 1000 });
    expect(processor.armedSelect).toBeNull();
  });
});

describe('control execution outcomes', () => {
  test('a pulse still running rejects the next OPERATE with ALREADY_ACTIVE', () => {
    const { processor, calls } = harness();
    // on-time 1000 ms, count 1 -> busy until t=2000.
    processor.process(parseRequest(SELECT_CROB), 1000);
    expect(processor.process(parseRequest(OPERATE_CROB), 1000).statuses)
      .toEqual([DNP3_COMMAND_STATUS.SUCCESS]);

    processor.process(parseRequest(SELECT_CROB), 1500);
    expect(processor.process(parseRequest(OPERATE_CROB), 1500).statuses)
      .toEqual([DNP3_COMMAND_STATUS.ALREADY_ACTIVE]);
    expect(calls).toHaveLength(1); // the second one never reached the sink

    // Once the pulse has finished the point accepts commands again.
    processor.process(parseRequest(SELECT_CROB), 2100);
    expect(processor.process(parseRequest(OPERATE_CROB), 2100).statuses)
      .toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls).toHaveLength(2);
  });

  test('an unmapped point is rejected and sets the OBJECT_UNKNOWN IIN bit', () => {
    const { processor, calls } = harness();
    const unmapped = Buffer.from(OPERATE_CROB);
    unmapped[1] = DNP3_FUNCTION.DIRECT_OPERATE;
    unmapped[6] = 0x7f; // point 127 is not in the map
    const result = processor.process(parseRequest(unmapped), 1000);
    expect(result.statuses).toEqual([DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
    expect(result.iin & DNP3_IIN.OBJECT_UNKNOWN).toBe(DNP3_IIN.OBJECT_UNKNOWN);
    expect(calls).toEqual([]);
  });

  test('a CROB count of 0 is a spec no-op: SUCCESS without touching the sink', () => {
    const { processor, calls } = harness();
    const noop = Buffer.from(OPERATE_CROB);
    noop[1] = DNP3_FUNCTION.DIRECT_OPERATE;
    noop[8] = 0x00; // count field = 0
    expect(processor.process(parseRequest(noop), 1000).statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls).toEqual([]);
  });

  test('the deprecated queue bit and the clear bit are refused, not silently ignored', () => {
    const { processor, calls } = harness();
    for (const bit of [0x10, 0x20]) {
      const req = Buffer.from(OPERATE_CROB);
      req[1] = DNP3_FUNCTION.DIRECT_OPERATE;
      req[7] = 0x41 | bit;
      expect(processor.process(parseRequest(req), 1000).statuses)
        .toEqual([DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
    }
    expect(calls).toEqual([]);
  });

  test('a NUL operation type is refused', () => {
    const { processor } = harness();
    const req = Buffer.from(OPERATE_CROB);
    req[1] = DNP3_FUNCTION.DIRECT_OPERATE;
    req[7] = 0x00;
    expect(processor.process(parseRequest(req), 1000).statuses)
      .toEqual([DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
  });

  test('a sink refusal is reported verbatim; a throwing sink becomes HARDWARE_ERROR', () => {
    const refusing = new Dnp3ControlProcessor(makeMap(), { enabled: true, selectTimeoutMs: 5000 }, () => ({
      ok: false,
      status: DNP3_COMMAND_STATUS.LOCAL,
    }));
    expect(refusing.process(parseRequest(DIRECT_OPERATE_AO), 1000).statuses)
      .toEqual([DNP3_COMMAND_STATUS.LOCAL]);

    const throwing = new Dnp3ControlProcessor(makeMap(), { enabled: true, selectTimeoutMs: 5000 }, () => {
      throw new Error('field device unreachable');
    });
    expect(throwing.process(parseRequest(DIRECT_OPERATE_AO), 1000).statuses)
      .toEqual([DNP3_COMMAND_STATUS.HARDWARE_ERROR]);
  });

  test('truncated control objects yield a parameter error and never execute', () => {
    const { processor, calls } = harness();
    // Claims one CROB but only supplies 3 of its 11 octets.
    const truncated = Buffer.from([0xc0, 0x05, 0x0c, 0x01, 0x17, 0x01, 0x00, 0x41, 0x01, 0xe8]);
    const req = parseRequest(truncated);
    expect(req.objects[0].items).toBeUndefined();
    const result = processor.process(req, 1000);
    expect(result.iin & DNP3_IIN.PARAMETER_ERROR).toBe(DNP3_IIN.PARAMETER_ERROR);
    expect(result.statuses).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a control function code with no control objects is a parameter error', () => {
    const { processor } = harness();
    const result = processor.process(parseRequest(Buffer.from([0xc0, 0x05])), 1000);
    expect(result.iin & DNP3_IIN.PARAMETER_ERROR).toBe(DNP3_IIN.PARAMETER_ERROR);
    expect(result.objects.length).toBe(0);
  });

  test('multiple objects in one request each get their own status', () => {
    const { processor, calls } = harness();
    // Two CROBs: point 1 (mapped) and point 9 (not mapped).
    const req = Buffer.from([
      0xc0, DNP3_FUNCTION.DIRECT_OPERATE, 0x0c, 0x01, 0x17, 0x02,
      0x01, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x09, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const result = processor.process(parseRequest(req), 1000);
    expect(result.statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS, DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ index: 1, tagId: 'pump.cmd', value: true });
    // Echo keeps the master's header and both index prefixes.
    expect([...result.objects.subarray(0, 6)]).toEqual([0x0c, 0x01, 0x17, 0x02, 0x01, 0x03]);
    // 4-octet header, then two 12-octet blocks (1 index prefix + 11 CROB octets);
    // each block's status octet is its last one.
    expect(result.objects.length).toBe(4 + 12 + 12);
    expect(result.objects[15]).toBe(DNP3_COMMAND_STATUS.SUCCESS);
    expect(result.objects[27]).toBe(DNP3_COMMAND_STATUS.NOT_SUPPORTED);
  });

  test('a SELECT containing an invalid object arms nothing', () => {
    const { processor } = harness();
    const req = Buffer.from([
      0xc0, DNP3_FUNCTION.SELECT, 0x0c, 0x01, 0x17, 0x02,
      0x01, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x09, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const result = processor.process(parseRequest(req), 1000);
    expect(result.statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS, DNP3_COMMAND_STATUS.NOT_SUPPORTED]);
    expect(processor.armedSelect).toBeNull();
  });

  test('disarm() drops an armed selection', () => {
    const { processor } = harness();
    processor.process(parseRequest(SELECT_CROB), 1000);
    expect(processor.armedSelect).not.toBeNull();
    processor.disarm();
    expect(processor.process(parseRequest(OPERATE_CROB), 1100).statuses)
      .toEqual([DNP3_COMMAND_STATUS.NO_SELECT]);
  });

  test('qualifier 0x28 (2-octet prefix/count) control objects are handled', () => {
    const map = new Dnp3PointMap({ points: [{ tagId: 'far.cmd', type: 'binaryOutput', index: 300 }] });
    const calls: Dnp3ControlCommand[] = [];
    const processor = new Dnp3ControlProcessor(map, { enabled: true, selectTimeoutMs: 5000 }, (cmd) => {
      calls.push(cmd);
      return { ok: true };
    });
    const req = Buffer.from([
      0xc0, DNP3_FUNCTION.DIRECT_OPERATE, 0x0c, 0x01, 0x28,
      0x01, 0x00, // count 1 (2 octets)
      0x2c, 0x01, // index 300 (2 octets)
      0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // LATCH_ON
    ]);
    const parsed = parseRequest(req);
    expect(parsed.objects[0].items![0].index).toBe(300);
    const result = processor.process(parsed, 1000);
    expect(result.statuses).toEqual([DNP3_COMMAND_STATUS.SUCCESS]);
    expect(calls[0]).toMatchObject({ index: 300, tagId: 'far.cmd', value: true });
    // Echo preserves the 0x28 qualifier and the 2-octet count/prefix.
    expect([...result.objects.subarray(0, 7)]).toEqual([0x0c, 0x01, 0x28, 0x01, 0x00, 0x2c, 0x01]);
  });

  test('the sink receives exactly one call per executed object', () => {
    const sink = vi.fn<Dnp3ControlSink>(() => ({ ok: true }));
    const processor = new Dnp3ControlProcessor(makeMap(), { enabled: true, selectTimeoutMs: 5000 }, sink);
    processor.process(parseRequest(SELECT_CROB), 1000);
    expect(sink).not.toHaveBeenCalled();
    processor.process(parseRequest(OPERATE_CROB), 1000);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
