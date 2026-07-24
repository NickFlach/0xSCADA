/**
 * Tests for DNP3 application-layer APDU assembly + the pure request handler (#464).
 */
import { describe, test, expect } from 'vitest';
import {
  parseRequest,
  buildResponseHeader,
  buildClass0Objects,
  classReadTargets,
  buildIin,
  APP_CTRL_FIR,
  APP_CTRL_FIN,
} from '../app-layer';
import { Dnp3PointMap } from '../point-map';
import { Dnp3EventBuffer, DEFAULT_EVENT_BUFFER_CONFIG } from '../event-buffer';
import { Sav5Outstation } from '../secure-auth';
import { handleApplicationRequest, type OutstationContext } from '../index';
import { DNP3_FUNCTION, DNP3_GROUP, DNP3_VARIATION, DNP3_IIN } from '../app-objects';

function readClass0Fragment(): Buffer {
  // APP_CONTROL(FIR|FIN) | READ | g60 v1 (class0) qualifier 0x06 (all)
  return Buffer.from([0xc0, DNP3_FUNCTION.READ, DNP3_GROUP.CLASS_DATA, DNP3_VARIATION.CLASS0, 0x06]);
}

function readClass123Fragment(): Buffer {
  return Buffer.from([
    0xc1,
    DNP3_FUNCTION.READ,
    DNP3_GROUP.CLASS_DATA, DNP3_VARIATION.CLASS1, 0x06,
    DNP3_GROUP.CLASS_DATA, DNP3_VARIATION.CLASS2, 0x06,
    DNP3_GROUP.CLASS_DATA, DNP3_VARIATION.CLASS3, 0x06,
  ]);
}

describe('parseRequest', () => {
  test('parses header bits and class-data objects', () => {
    const req = parseRequest(readClass0Fragment());
    expect(req.fir).toBe(true);
    expect(req.fin).toBe(true);
    expect(req.func).toBe(DNP3_FUNCTION.READ);
    expect(req.objects[0]).toEqual({ group: 60, variation: 1, qualifier: 0x06 });
  });

  test('classReadTargets identifies class 0', () => {
    const t = classReadTargets(parseRequest(readClass0Fragment()));
    expect(t).toEqual({ class0: true, class1: false, class2: false, class3: false });
  });

  test('classReadTargets identifies class 1/2/3', () => {
    const t = classReadTargets(parseRequest(readClass123Fragment()));
    expect(t).toEqual({ class0: false, class1: true, class2: true, class3: true });
  });

  test('throws on a too-short fragment', () => {
    expect(() => parseRequest(Buffer.from([0xc0]))).toThrow();
  });
});

describe('buildResponseHeader / buildIin', () => {
  test('response header: FIR|FIN set, function 0x81, IIN little-endian', () => {
    const iin = buildIin({ deviceRestart: true, class1Events: true });
    const hdr = buildResponseHeader({ seq: 3, iin });
    expect(hdr[0] & APP_CTRL_FIR).toBe(APP_CTRL_FIR);
    expect(hdr[0] & APP_CTRL_FIN).toBe(APP_CTRL_FIN);
    expect(hdr[0] & 0x0f).toBe(3);
    expect(hdr[1]).toBe(DNP3_FUNCTION.RESPONSE);
    expect(hdr.readUInt16LE(2)).toBe(iin);
    expect(iin & DNP3_IIN.DEVICE_RESTART).toBe(DNP3_IIN.DEVICE_RESTART);
    expect(iin & DNP3_IIN.CLASS1_EVENTS).toBe(DNP3_IIN.CLASS1_EVENTS);
  });

  test('unsolicited header uses function 0x82', () => {
    const hdr = buildResponseHeader({ seq: 0, unsolicited: true, iin: 0 });
    expect(hdr[1]).toBe(DNP3_FUNCTION.UNSOLICITED_RESPONSE);
  });
});

describe('buildClass0Objects', () => {
  test('assembles contiguous static points into range headers', () => {
    const map = new Dnp3PointMap({
      points: [
        { tagId: 'bi0', type: 'binaryInput', index: 0 },
        { tagId: 'bi1', type: 'binaryInput', index: 1 },
        { tagId: 'ai0', type: 'analogInput', index: 0, encoding: 'int32' },
      ],
    });
    map.applyTagUpdate('bi0', { value: true, quality: 'good', timestamp: 1 });
    map.applyTagUpdate('bi1', { value: false, quality: 'good', timestamp: 1 });
    map.applyTagUpdate('ai0', { value: 1234, quality: 'good', timestamp: 1 });

    const objs = buildClass0Objects(map);
    // First object header: group 1 (binary input), var 2, qualifier 0x00, start 0, stop 1
    expect(objs[0]).toBe(DNP3_GROUP.BINARY_INPUT_STATIC);
    expect(objs[1]).toBe(DNP3_VARIATION.BI_WITH_FLAGS);
    expect(objs[2]).toBe(0x00);
    expect(objs[3]).toBe(0); // start
    expect(objs[4]).toBe(1); // stop
    // two binary flag octets follow (1 byte each)
    expect(objs.length).toBeGreaterThan(7);
  });

  test('empty map yields empty object block', () => {
    expect(buildClass0Objects(new Dnp3PointMap()).length).toBe(0);
  });
});

describe('handleApplicationRequest (pure)', () => {
  function makeCtx(withKey = false): OutstationContext {
    const pointMap = new Dnp3PointMap({
      points: [{ tagId: 'ai0', type: 'analogInput', index: 0, encoding: 'float32' }],
    });
    pointMap.applyTagUpdate('ai0', { value: 42, quality: 'good', timestamp: 1 });
    const secureAuth = new Sav5Outstation();
    if (withKey) secureAuth.setUpdateKey(1, Buffer.alloc(16, 0x11));
    return {
      pointMap,
      eventBuffer: new Dnp3EventBuffer(DEFAULT_EVENT_BUFFER_CONFIG),
      secureAuth,
      restartPending: false,
      unsolicitedEnabled: false,
    };
  }

  test('class 0 read returns a response with static data', () => {
    const ctx = makeCtx();
    const { response, challenged } = handleApplicationRequest(ctx, parseRequest(readClass0Fragment()));
    expect(challenged).toBe(false);
    expect(response[1]).toBe(DNP3_FUNCTION.RESPONSE);
    // contains the AI static object header (group 30)
    expect(response.includes(DNP3_GROUP.ANALOG_INPUT_STATIC)).toBe(true);
  });

  test('enable/disable unsolicited toggles context flag', () => {
    const ctx = makeCtx();
    handleApplicationRequest(ctx, parseRequest(Buffer.from([0xc0, DNP3_FUNCTION.ENABLE_UNSOLICITED])));
    expect(ctx.unsolicitedEnabled).toBe(true);
    handleApplicationRequest(ctx, parseRequest(Buffer.from([0xc0, DNP3_FUNCTION.DISABLE_UNSOLICITED])));
    expect(ctx.unsolicitedEnabled).toBe(false);
  });

  test('unsupported function code sets NO_FUNC_CODE_SUPPORT IIN', () => {
    const ctx = makeCtx();
    const { response } = handleApplicationRequest(ctx, parseRequest(Buffer.from([0xc0, 0x7e])));
    const iin = response.readUInt16LE(2);
    expect(iin & DNP3_IIN.NO_FUNC_CODE_SUPPORT).toBe(DNP3_IIN.NO_FUNC_CODE_SUPPORT);
  });

  test('critical function (OPERATE) is challenged when a key is provisioned', () => {
    const ctx = makeCtx(true);
    const operate = Buffer.from([0xc0, DNP3_FUNCTION.OPERATE, 0x0c, 0x01, 0x17, 0x01, 0x00, 0x41]);
    const { challenged, response } = handleApplicationRequest(ctx, parseRequest(operate), { userNumber: 1, now: 1000 });
    expect(challenged).toBe(true);
    // The response carries a g120 (secure auth) object header.
    expect(response.includes(DNP3_GROUP.SECURE_AUTH)).toBe(true);
    expect(ctx.secureAuth.hasPending(1)).toBe(true);
  });

  test('critical function is NOT challenged when no key is provisioned (open mode)', () => {
    const ctx = makeCtx(false);
    const operate = Buffer.from([0xc0, DNP3_FUNCTION.OPERATE, 0x0c, 0x01, 0x17, 0x01, 0x00, 0x41]);
    const { challenged } = handleApplicationRequest(ctx, parseRequest(operate), { userNumber: 1 });
    expect(challenged).toBe(false);
  });

  test('device restart pending is reflected in IIN', () => {
    const ctx = makeCtx();
    ctx.restartPending = true;
    const { response } = handleApplicationRequest(ctx, parseRequest(readClass0Fragment()));
    expect(response.readUInt16LE(2) & DNP3_IIN.DEVICE_RESTART).toBe(DNP3_IIN.DEVICE_RESTART);
  });
});
