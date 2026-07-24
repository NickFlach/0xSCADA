/**
 * Tests for DNP3 point map + app-object encoders (Issue #464).
 */
import { describe, test, expect } from 'vitest';
import {
  Dnp3PointMap,
  defaultGroupVariation,
  deriveFlags,
  serializeStaticPoint,
  type Dnp3PointDef,
} from '../point-map';
import {
  buildBinaryFlags,
  buildAnalogFlags,
  qualityToFlags,
  encodeAnalog32WithFlag,
  encodeAnalogFloatWithFlag,
  encodeCounter32WithFlag,
  DNP3_FLAG,
  DNP3_GROUP,
  DNP3_VARIATION,
} from '../app-objects';

describe('app-object flag encoding', () => {
  test('good analog quality => ONLINE only', () => {
    const flags = buildAnalogFlags(qualityToFlags('good'));
    expect(flags).toBe(DNP3_FLAG.ONLINE);
  });

  test('bad quality clears ONLINE and sets COMM_LOST', () => {
    const flags = buildAnalogFlags(qualityToFlags('bad'));
    expect(flags & DNP3_FLAG.ONLINE).toBe(0);
    expect(flags & DNP3_FLAG.COMM_LOST).toBe(DNP3_FLAG.COMM_LOST);
  });

  test('binary state lives in bit 7', () => {
    const on = buildBinaryFlags({ online: true, state: true });
    const off = buildBinaryFlags({ online: true, state: false });
    expect(on & DNP3_FLAG.STATE).toBe(DNP3_FLAG.STATE);
    expect(off & DNP3_FLAG.STATE).toBe(0);
    expect(on & DNP3_FLAG.ONLINE).toBe(DNP3_FLAG.ONLINE);
  });

  test('uncertain quality sets LOCAL_FORCED but keeps ONLINE', () => {
    const flags = buildAnalogFlags(qualityToFlags('uncertain'));
    expect(flags & DNP3_FLAG.ONLINE).toBe(DNP3_FLAG.ONLINE);
    expect(flags & DNP3_FLAG.LOCAL_FORCED).toBe(DNP3_FLAG.LOCAL_FORCED);
  });
});

describe('analog/counter value encoders (little-endian + flag)', () => {
  test('encodeAnalog32WithFlag layout', () => {
    const buf = encodeAnalog32WithFlag(0x01020304, DNP3_FLAG.ONLINE);
    expect(buf.length).toBe(5);
    expect(buf[0]).toBe(DNP3_FLAG.ONLINE);
    expect(buf.readInt32LE(1)).toBe(0x01020304);
  });

  test('encodeAnalog32WithFlag clamps overflow', () => {
    const buf = encodeAnalog32WithFlag(5e9, 0);
    expect(buf.readInt32LE(1)).toBe(2147483647);
  });

  test('encodeAnalogFloatWithFlag round-trips', () => {
    const buf = encodeAnalogFloatWithFlag(3.5, 0);
    expect(buf.readFloatLE(1)).toBeCloseTo(3.5);
  });

  test('encodeCounter32WithFlag is unsigned', () => {
    const buf = encodeCounter32WithFlag(0xfffffffe, 0);
    expect(buf.readUInt32LE(1)).toBe(0xfffffffe);
  });
});

describe('Dnp3PointMap', () => {
  const defs: Dnp3PointDef[] = [
    { tagId: 'pump.run', type: 'binaryInput', index: 0, eventClass: 1 },
    { tagId: 'tank.level', type: 'analogInput', index: 0, eventClass: 2, encoding: 'float32' },
    { tagId: 'flow.total', type: 'counter', index: 0, eventClass: 0 },
    { tagId: 'valve.cmd', type: 'binaryOutput', index: 0 },
    { tagId: 'setpoint', type: 'analogOutput', index: 0, encoding: 'int32' },
  ];

  test('registers points across all five groups', () => {
    const map = new Dnp3PointMap({ points: defs });
    expect(map.count('binaryInput')).toBe(1);
    expect(map.count('analogInput')).toBe(1);
    expect(map.count('counter')).toBe(1);
    expect(map.count('binaryOutput')).toBe(1);
    expect(map.count('analogOutput')).toBe(1);
  });

  test('rejects duplicate (type,index)', () => {
    const map = new Dnp3PointMap();
    map.addPoint({ tagId: 'a', type: 'binaryInput', index: 0 });
    expect(() => map.addPoint({ tagId: 'b', type: 'binaryInput', index: 0 })).toThrow();
  });

  test('applyTagUpdate scales analog and normalises boolean', () => {
    const map = new Dnp3PointMap({
      points: [{ tagId: 'temp', type: 'analogInput', index: 0, scale: 0.1 }],
    });
    map.applyTagUpdate('temp', { value: 250, quality: 'good', timestamp: 1 });
    const resolved = map.resolve('analogInput', 0)!;
    expect(resolved.sample.value).toBeCloseTo(25);
  });

  test('boolean tag feeding binary input becomes boolean', () => {
    const map = new Dnp3PointMap({ points: [{ tagId: 'di', type: 'binaryInput', index: 0 }] });
    map.applyTagUpdate('di', { value: 1, quality: 'good', timestamp: 1 });
    expect(map.resolve('binaryInput', 0)!.sample.value).toBe(true);
  });

  test('one tag can feed multiple points', () => {
    const map = new Dnp3PointMap({
      points: [
        { tagId: 'shared', type: 'binaryInput', index: 0 },
        { tagId: 'shared', type: 'analogInput', index: 5 },
      ],
    });
    const changed = map.applyTagUpdate('shared', { value: 1, quality: 'good', timestamp: 1 });
    expect(changed.length).toBe(2);
  });

  test('default group/variation per type', () => {
    expect(defaultGroupVariation(defs[0])).toEqual({
      group: DNP3_GROUP.BINARY_INPUT_STATIC,
      variation: DNP3_VARIATION.BI_WITH_FLAGS,
    });
    expect(defaultGroupVariation(defs[1])).toEqual({
      group: DNP3_GROUP.ANALOG_INPUT_STATIC,
      variation: DNP3_VARIATION.AI_FLOAT_WITH_FLAG,
    });
    expect(defaultGroupVariation(defs[4])).toEqual({
      group: DNP3_GROUP.ANALOG_OUTPUT_STATUS,
      variation: DNP3_VARIATION.AO_STATUS_32_WITH_FLAG,
    });
  });
});

describe('serializeStaticPoint', () => {
  test('binary input carries state in flag bit 7', () => {
    const map = new Dnp3PointMap({ points: [{ tagId: 'b', type: 'binaryInput', index: 0 }] });
    map.applyTagUpdate('b', { value: true, quality: 'good', timestamp: 1 });
    const { data } = serializeStaticPoint(map.resolve('binaryInput', 0)!);
    expect(data.length).toBe(1);
    expect(data[0] & DNP3_FLAG.STATE).toBe(DNP3_FLAG.STATE);
    expect(data[0] & DNP3_FLAG.ONLINE).toBe(DNP3_FLAG.ONLINE);
  });

  test('float analog input serialises flag + 4-byte float', () => {
    const map = new Dnp3PointMap({ points: [{ tagId: 'a', type: 'analogInput', index: 0, encoding: 'float32' }] });
    map.applyTagUpdate('a', { value: 12.25, quality: 'good', timestamp: 1 });
    const { data } = serializeStaticPoint(map.resolve('analogInput', 0)!);
    expect(data.length).toBe(5);
    expect(data.readFloatLE(1)).toBeCloseTo(12.25);
  });

  test('bad-quality point reflects COMM_LOST in flags', () => {
    const map = new Dnp3PointMap({ points: [{ tagId: 'a', type: 'analogInput', index: 0, encoding: 'int32' }] });
    map.applyTagUpdate('a', { value: 7, quality: 'bad', timestamp: 1 });
    const resolved = map.resolve('analogInput', 0)!;
    const flags = deriveFlags(resolved);
    expect(flags & DNP3_FLAG.COMM_LOST).toBe(DNP3_FLAG.COMM_LOST);
    expect(flags & DNP3_FLAG.ONLINE).toBe(0);
  });
});
