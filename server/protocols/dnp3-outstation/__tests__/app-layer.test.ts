/**
 * Tests for DNP3 application-layer APDU assembly + the pure request handler (#464).
 */
import { describe, test, expect } from "vitest";
import {
  parseRequest,
  buildResponseHeader,
  buildFreeFormat16Object,
  buildClass0Objects,
  classReadTargets,
  buildIin,
  APP_CTRL_FIR,
  APP_CTRL_FIN,
} from "../app-layer";
import { Dnp3PointMap } from "../point-map";
import { Dnp3EventBuffer, DEFAULT_EVENT_BUFFER_CONFIG } from "../event-buffer";
import { Sav5Outstation } from "../secure-auth";
import {
  createOutstationContext,
  handleApplicationRequest,
  type OutstationContext,
} from "../index";
import {
  DNP3_FUNCTION,
  DNP3_GROUP,
  DNP3_VARIATION,
  DNP3_IIN,
} from "../app-objects";

function readClass0Fragment(): Buffer {
  // APP_CONTROL(FIR|FIN) | READ | g60 v1 (class0) qualifier 0x06 (all)
  return Buffer.from([
    0xc0,
    DNP3_FUNCTION.READ,
    DNP3_GROUP.CLASS_DATA,
    DNP3_VARIATION.CLASS0,
    0x06,
  ]);
}

function readClass123Fragment(): Buffer {
  return Buffer.from([
    0xc1,
    DNP3_FUNCTION.READ,
    DNP3_GROUP.CLASS_DATA,
    DNP3_VARIATION.CLASS1,
    0x06,
    DNP3_GROUP.CLASS_DATA,
    DNP3_VARIATION.CLASS2,
    0x06,
    DNP3_GROUP.CLASS_DATA,
    DNP3_VARIATION.CLASS3,
    0x06,
  ]);
}

function operateLatchOnFragment(): Buffer {
  return Buffer.from([
    0xc0,
    DNP3_FUNCTION.OPERATE,
    DNP3_GROUP.BINARY_OUTPUT_COMMAND,
    DNP3_VARIATION.CROB,
    0x17, // one-octet index prefix + one-octet count
    0x01, // one CROB
    0x00, // point index 0
    0x03, // LATCH_ON
    0x01, // count
    0x00,
    0x00,
    0x00,
    0x00, // on-time
    0x00,
    0x00,
    0x00,
    0x00, // off-time
    0x00, // command status
  ]);
}

describe("parseRequest", () => {
  test("parses header bits and class-data objects", () => {
    const req = parseRequest(readClass0Fragment());
    expect(req.fir).toBe(true);
    expect(req.fin).toBe(true);
    expect(req.func).toBe(DNP3_FUNCTION.READ);
    expect(req.objects[0]).toEqual({
      group: 60,
      variation: 1,
      qualifier: 0x06,
    });
  });

  test("classReadTargets identifies class 0", () => {
    const t = classReadTargets(parseRequest(readClass0Fragment()));
    expect(t).toEqual({
      class0: true,
      class1: false,
      class2: false,
      class3: false,
    });
  });

  test("classReadTargets identifies class 1/2/3", () => {
    const t = classReadTargets(parseRequest(readClass123Fragment()));
    expect(t).toEqual({
      class0: false,
      class1: true,
      class2: true,
      class3: true,
    });
  });

  test("throws on a too-short fragment", () => {
    expect(() => parseRequest(Buffer.from([0xc0]))).toThrow();
  });

  test("decodes the packed g80v1 restart-acknowledgement write", () => {
    const req = parseRequest(
      Buffer.from([
        0xc0,
        DNP3_FUNCTION.WRITE,
        DNP3_GROUP.INTERNAL_INDICATIONS,
        1,
        0x00,
        7,
        7,
        0,
      ]),
    );
    expect(req.objects[0]).toEqual({
      group: DNP3_GROUP.INTERNAL_INDICATIONS,
      variation: 1,
      qualifier: 0x00,
      range: { start: 7, stop: 7 },
      count: 1,
      data: Buffer.from([0]),
    });
  });

  test("decodes qualifier-0x5B count8 + size16 free-format objects", () => {
    const body = Buffer.from([1, 2, 3, 4, 5, 6]);
    const req = parseRequest(
      Buffer.concat([
        Buffer.from([
          0xc0,
          DNP3_FUNCTION.AUTH_REQUEST,
          DNP3_GROUP.SECURE_AUTH,
          2,
          0x5b,
          1,
          body.length,
          0,
        ]),
        body,
      ]),
    );
    expect(req.objects).toHaveLength(1);
    expect(req.objects[0]).toMatchObject({
      group: DNP3_GROUP.SECURE_AUTH,
      variation: 2,
      qualifier: 0x5b,
      count: 1,
    });
    expect(req.objects[0].freeFormat).toEqual([body]);
  });
});

describe("buildResponseHeader / buildIin", () => {
  test("response header: FIR|FIN set, function 0x81, IIN little-endian", () => {
    const iin = buildIin({ deviceRestart: true, class1Events: true });
    const hdr = buildResponseHeader({ seq: 3, iin });
    expect(hdr[0] & APP_CTRL_FIR).toBe(APP_CTRL_FIR);
    expect(hdr[0] & APP_CTRL_FIN).toBe(APP_CTRL_FIN);
    expect(hdr[0] & 0x0f).toBe(3);
    expect(hdr[1]).toBe(DNP3_FUNCTION.RESPONSE);
    expect(hdr.readUInt16LE(2)).toBe(iin);
    expect(iin & DNP3_IIN.DEVICE_RESTART).toBe(DNP3_IIN.DEVICE_RESTART);
    expect(iin & DNP3_IIN.CLASS1_EVENTS).toBe(DNP3_IIN.CLASS1_EVENTS);
    expect([...hdr.subarray(2)]).toEqual([0x82, 0x00]);
  });

  test("IIN2 error bits occupy the second wire octet", () => {
    const hdr = buildResponseHeader({
      seq: 0,
      iin: buildIin({ parameterError: true }),
    });
    expect([...hdr.subarray(2)]).toEqual([0x00, 0x04]);
  });

  test("unsolicited header uses function 0x82", () => {
    const hdr = buildResponseHeader({ seq: 0, unsolicited: true, iin: 0 });
    expect(hdr[1]).toBe(DNP3_FUNCTION.UNSOLICITED_RESPONSE);
  });

  test("explicit Secure Authentication response uses function 0x83", () => {
    const hdr = buildResponseHeader({
      seq: 4,
      functionCode: DNP3_FUNCTION.AUTH_RESPONSE,
      iin: 0,
    });
    expect(hdr[1]).toBe(DNP3_FUNCTION.AUTH_RESPONSE);
  });
});

describe("buildClass0Objects", () => {
  test("assembles contiguous static points into range headers", () => {
    const map = new Dnp3PointMap({
      points: [
        { tagId: "bi0", type: "binaryInput", index: 0 },
        { tagId: "bi1", type: "binaryInput", index: 1 },
        { tagId: "ai0", type: "analogInput", index: 0, encoding: "int32" },
      ],
    });
    map.applyTagUpdate("bi0", { value: true, quality: "good", timestamp: 1 });
    map.applyTagUpdate("bi1", { value: false, quality: "good", timestamp: 1 });
    map.applyTagUpdate("ai0", { value: 1234, quality: "good", timestamp: 1 });

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

  test("empty map yields empty object block", () => {
    expect(buildClass0Objects(new Dnp3PointMap()).length).toBe(0);
  });
});

describe("handleApplicationRequest (pure)", () => {
  function makeCtx(withKey = false): OutstationContext {
    const pointMap = new Dnp3PointMap({
      points: [
        { tagId: "ai0", type: "analogInput", index: 0, encoding: "float32" },
      ],
    });
    pointMap.applyTagUpdate("ai0", {
      value: 42,
      quality: "good",
      timestamp: 1,
    });
    const secureAuth = new Sav5Outstation();
    if (withKey) secureAuth.setControlDirectionKey(1, Buffer.alloc(16, 0x11));
    return createOutstationContext({
      pointMap,
      eventBuffer: new Dnp3EventBuffer(DEFAULT_EVENT_BUFFER_CONFIG),
      secureAuth,
      restartPending: false,
      unsolicitedEnabled: false,
    });
  }

  test("class 0 read returns a response with static data", () => {
    const ctx = makeCtx();
    const { response, challenged } = handleApplicationRequest(
      ctx,
      parseRequest(readClass0Fragment()),
    );
    expect(challenged).toBe(false);
    expect(response[1]).toBe(DNP3_FUNCTION.RESPONSE);
    // contains the AI static object header (group 30)
    expect(response.includes(DNP3_GROUP.ANALOG_INPUT_STATIC)).toBe(true);
  });

  test("enable/disable unsolicited toggles context flag", () => {
    const ctx = makeCtx();
    handleApplicationRequest(
      ctx,
      parseRequest(Buffer.from([0xc0, DNP3_FUNCTION.ENABLE_UNSOLICITED])),
    );
    expect(ctx.unsolicitedEnabled).toBe(true);
    handleApplicationRequest(
      ctx,
      parseRequest(Buffer.from([0xc0, DNP3_FUNCTION.DISABLE_UNSOLICITED])),
    );
    expect(ctx.unsolicitedEnabled).toBe(false);
  });

  test("unsupported function code sets NO_FUNC_CODE_SUPPORT IIN", () => {
    const ctx = makeCtx();
    const { response } = handleApplicationRequest(
      ctx,
      parseRequest(Buffer.from([0xc0, 0x7e])),
    );
    const iin = response.readUInt16LE(2);
    expect(iin & DNP3_IIN.NO_FUNC_CODE_SUPPORT).toBe(
      DNP3_IIN.NO_FUNC_CODE_SUPPORT,
    );
  });

  test("critical function (OPERATE) is challenged when a key is provisioned", () => {
    const ctx = makeCtx(true);
    const operate = operateLatchOnFragment();
    const { challenged, response } = handleApplicationRequest(
      ctx,
      parseRequest(operate),
      { userNumber: 1, now: 1000 },
    );
    expect(challenged).toBe(true);
    expect(response[1]).toBe(DNP3_FUNCTION.AUTH_RESPONSE);
    expect(response.subarray(4, 10)).toEqual(
      Buffer.from([
        DNP3_GROUP.SECURE_AUTH,
        1,
        0x5b,
        1,
        response.length - 10,
        0,
      ]),
    );
    expect(ctx.secureAuth.hasPending(ctx.session.sav5AssociationId)).toBe(true);
  });

  test("Wait-for-Reply discards other ASDUs, then expires cleanly", () => {
    const ctx = makeCtx(true);
    const operate = operateLatchOnFragment();
    handleApplicationRequest(ctx, parseRequest(operate), { now: 0 });

    const duringWait = handleApplicationRequest(
      ctx,
      parseRequest(readClass0Fragment()),
      {
        now: 100,
      },
    );
    expect(duringWait.response).toEqual(Buffer.alloc(0));

    const afterExpiry = handleApplicationRequest(
      ctx,
      parseRequest(readClass0Fragment()),
      {
        now: 5001,
      },
    );
    expect(afterExpiry.response[1]).toBe(DNP3_FUNCTION.RESPONSE);
  });

  test("a valid g120v7 AUTH_REQUEST_NO_ACK cancels Wait-for-Reply", () => {
    const ctx = makeCtx(true);
    const operate = operateLatchOnFragment();
    handleApplicationRequest(ctx, parseRequest(operate), { now: 0 });
    const authError = parseRequest(
      Buffer.concat([
        Buffer.from([0xc0, DNP3_FUNCTION.AUTH_REQUEST_NO_ACK]),
        buildFreeFormat16Object(DNP3_GROUP.SECURE_AUTH, 7, Buffer.alloc(15)),
      ]),
    );
    const result = handleApplicationRequest(ctx, authError, { now: 1 });
    expect(result.response).toEqual(Buffer.alloc(0));
    expect(ctx.secureAuth.hasPending(ctx.session.sav5AssociationId)).toBe(
      false,
    );
  });

  test("a mutating ASDU with trailing undecoded data fails before challenge or execution", () => {
    const ctx = makeCtx(true);
    const malformed = parseRequest(
      Buffer.concat([operateLatchOnFragment(), Buffer.from([0xff])]),
    );
    expect(malformed.objectsComplete).toBe(false);
    const result = handleApplicationRequest(ctx, malformed, { now: 0 });
    expect(result.challenged).toBe(false);
    expect(result.response.readUInt16LE(2) & DNP3_IIN.PARAMETER_ERROR).toBe(
      DNP3_IIN.PARAMETER_ERROR,
    );
    expect(ctx.secureAuth.hasPending(ctx.session.sav5AssociationId)).toBe(
      false,
    );
  });

  test("critical function is NOT challenged when no key is provisioned (open mode)", () => {
    const ctx = makeCtx(false);
    const operate = operateLatchOnFragment();
    const { challenged } = handleApplicationRequest(
      ctx,
      parseRequest(operate),
      { userNumber: 1 },
    );
    expect(challenged).toBe(false);
  });

  test("device restart pending is reflected in IIN", () => {
    const ctx = makeCtx();
    ctx.restartPending = true;
    const { response } = handleApplicationRequest(
      ctx,
      parseRequest(readClass0Fragment()),
    );
    expect(response.readUInt16LE(2) & DNP3_IIN.DEVICE_RESTART).toBe(
      DNP3_IIN.DEVICE_RESTART,
    );
  });

  test("WRITE g80v1 clears DEVICE_RESTART and acknowledges without an error IIN", () => {
    const ctx = makeCtx();
    ctx.restartPending = true;
    const clearRestart = Buffer.from([
      0xc5,
      DNP3_FUNCTION.WRITE,
      DNP3_GROUP.INTERNAL_INDICATIONS,
      1,
      0x00,
      7,
      7,
      0,
    ]);
    const { response } = handleApplicationRequest(
      ctx,
      parseRequest(clearRestart),
    );
    expect(ctx.restartPending).toBe(false);
    expect(response[0] & 0x0f).toBe(5);
    expect(response.readUInt16LE(2)).toBe(0);
  });

  test("WRITE g80v1 cannot set DEVICE_RESTART from the master side", () => {
    const ctx = makeCtx();
    const setRestart = Buffer.from([
      0xc0,
      DNP3_FUNCTION.WRITE,
      DNP3_GROUP.INTERNAL_INDICATIONS,
      1,
      0x00,
      7,
      7,
      1,
    ]);
    const { response } = handleApplicationRequest(
      ctx,
      parseRequest(setRestart),
    );
    expect(response.readUInt16LE(2) & DNP3_IIN.PARAMETER_ERROR).toBe(
      DNP3_IIN.PARAMETER_ERROR,
    );
    expect(ctx.restartPending).toBe(false);
  });
});
