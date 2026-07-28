/**
 * Tag-store bridge tests (#462): reads observe live tag values, writes
 * propagate back into the tag store (the issue's core verification).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RegisterMap } from "../register-map";
import { InMemoryTagStore, TagStoreDataModel } from "../tag-store-bridge";
import { DataModelError } from "../data-model";
import { processRequest } from "../handlers";
import {
  EXCEPTION_FLAG,
  ExceptionCode,
  FunctionCode,
  decodeRequest,
  type ModbusRequest,
} from "../codec";

/**
 * `writable` is opt-in per address: `config.locked` and `device.serial` are
 * deliberately left at the default (not writable) so the write-scoping rules
 * are exercised against a map that also contains writable addresses.
 */
function makeMap() {
  return RegisterMap.fromConfig({
    siteId: "site-1",
    unitId: 1,
    entries: [
      {
        tagId: "pump.run",
        area: "coil",
        address: 0,
        dataType: "bool",
        writable: true,
      },
      {
        tagId: "alarm.active",
        area: "discreteInput",
        address: 0,
        dataType: "bool",
      },
      {
        tagId: "tank.level",
        area: "holdingRegister",
        address: 0,
        dataType: "uint16",
        writable: true,
      },
      {
        tagId: "flow.rate",
        area: "holdingRegister",
        address: 1,
        dataType: "float32",
        scale: 1,
        writable: true,
      },
      {
        tagId: "device.serial",
        area: "inputRegister",
        address: 5,
        dataType: "uint16",
      },
      {
        tagId: "config.locked",
        area: "holdingRegister",
        address: 10,
        dataType: "uint16",
      },
    ],
  });
}

function makeRequest(fc: number, data: Buffer): ModbusRequest {
  return {
    header: { transactionId: 1, protocolId: 0, length: 0, unitId: 1 },
    functionCode: fc,
    data,
  };
}

function isException(buf: Buffer): { exc: boolean; code: number } {
  const decoded = decodeRequest(buf)!;
  const fc = decoded.request.functionCode;
  return {
    exc: (fc & EXCEPTION_FLAG) !== 0,
    code: decoded.request.data.readUInt8(0),
  };
}

describe("TagStoreDataModel reads", () => {
  let store: InMemoryTagStore;
  let model: TagStoreDataModel;

  beforeEach(() => {
    store = new InMemoryTagStore();
    model = new TagStoreDataModel(makeMap(), store);
  });

  it("reads a coil from the live tag value", async () => {
    store.seed("pump.run", true);
    expect(await model.readCoils(0, 1)).toEqual([true]);
  });

  it("reads a holding register from the live tag value", async () => {
    store.seed("tank.level", 4242);
    expect(await model.readHoldingRegisters(0, 1)).toEqual([4242]);
  });

  it("reads a multi-register float32 value spanning two addresses", async () => {
    store.seed("flow.rate", 12.5);
    const words = await model.readHoldingRegisters(1, 2);
    // Recombine the words and confirm the float
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(words[0], 0);
    buf.writeUInt16BE(words[1], 2);
    expect(buf.readFloatBE(0)).toBeCloseTo(12.5, 5);
  });

  it("treats an unknown tag as a default (0 / false)", async () => {
    expect(await model.readCoils(0, 1)).toEqual([false]);
    expect(await model.readHoldingRegisters(0, 1)).toEqual([0]);
  });

  it("throws ILLEGAL_DATA_ADDRESS for an unmapped address", async () => {
    await expect(model.readHoldingRegisters(99, 1)).rejects.toBeInstanceOf(
      DataModelError,
    );
    await expect(model.readHoldingRegisters(99, 1)).rejects.toMatchObject({
      kind: "ILLEGAL_DATA_ADDRESS",
    });
  });
});

describe("TagStoreDataModel writes propagate into the tag store", () => {
  let store: InMemoryTagStore;
  let model: TagStoreDataModel;

  beforeEach(() => {
    store = new InMemoryTagStore();
    model = new TagStoreDataModel(makeMap(), store);
  });

  it("FC05 coil write reaches the tag store", async () => {
    await model.writeCoils(0, [true]);
    expect(store.peek("pump.run")).toBe(true);
  });

  it("FC06 register write reaches the tag store", async () => {
    await model.writeHoldingRegisters(0, [777]);
    expect(store.peek("tank.level")).toBe(777);
  });

  it("FC16 multi-register write decodes the float and stores it", async () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(9.75, 0);
    const words = [buf.readUInt16BE(0), buf.readUInt16BE(2)];
    await model.writeHoldingRegisters(1, words);
    expect(store.peek("flow.rate")).toBeCloseTo(9.75, 5);
  });

  it("rejects a write to an entry that is not marked writable", async () => {
    await expect(model.writeHoldingRegisters(10, [1])).rejects.toMatchObject({
      kind: "ILLEGAL_DATA_VALUE",
    });
    expect(store.peek("config.locked")).toBeUndefined();
  });

  it("defaults a mapped entry to not-writable when `writable` is omitted", async () => {
    const map = RegisterMap.fromConfig({
      siteId: "site-1",
      entries: [
        {
          tagId: "silent.setpoint",
          area: "holdingRegister",
          address: 0,
          dataType: "uint16",
        },
      ],
    });
    const scopedStore = new InMemoryTagStore();
    const scopedModel = new TagStoreDataModel(map, scopedStore);

    expect(map.entries[0].writable).toBe(false);
    await expect(scopedModel.writeHoldingRegisters(0, [5])).rejects.toMatchObject(
      { kind: "ILLEGAL_DATA_VALUE" },
    );
    expect(scopedStore.peek("silent.setpoint")).toBeUndefined();
  });

  it("does not partially apply a multi-coil write that spans a non-writable address", async () => {
    const map = RegisterMap.fromConfig({
      siteId: "site-1",
      entries: [
        {
          tagId: "coil.a",
          area: "coil",
          address: 0,
          dataType: "bool",
          writable: true,
        },
        { tagId: "coil.b", area: "coil", address: 1, dataType: "bool" },
      ],
    });
    const scopedStore = new InMemoryTagStore();
    const scopedModel = new TagStoreDataModel(map, scopedStore);

    await expect(scopedModel.writeCoils(0, [true, true])).rejects.toMatchObject({
      kind: "ILLEGAL_DATA_VALUE",
    });
    // coil.a must not have been mutated before the request was rejected.
    expect(scopedStore.peek("coil.a")).toBeUndefined();
    expect(scopedStore.peek("coil.b")).toBeUndefined();
  });

  it("rejects a write that truncates a multi-register entry", async () => {
    // Write only 1 word at flow.rate (needs 2)
    await expect(model.writeHoldingRegisters(1, [0x4120])).rejects.toMatchObject(
      { kind: "ILLEGAL_DATA_VALUE" },
    );
  });
});

describe("end-to-end through the handler layer", () => {
  it("FC06 over the wire updates the live tag store", async () => {
    const store = new InMemoryTagStore();
    const model = new TagStoreDataModel(makeMap(), store);

    // Write single register at hr0 = 0x0539 (1337)
    const data = Buffer.from([0x00, 0x00, 0x05, 0x39]);
    const resp = await processRequest(
      makeRequest(FunctionCode.WRITE_SINGLE_REGISTER, data),
      model,
    );
    expect(isException(resp).exc).toBe(false);
    expect(store.peek("tank.level")).toBe(0x0539);

    // Read it back via FC03
    const readResp = await processRequest(
      makeRequest(
        FunctionCode.READ_HOLDING_REGISTERS,
        Buffer.from([0x00, 0x00, 0x00, 0x01]),
      ),
      model,
    );
    const body = decodeRequest(readResp)!.request.data;
    expect(body.readUInt16BE(1)).toBe(0x0539);
  });

  it("FC03 read of an unmapped range returns Illegal Data Address", async () => {
    const store = new InMemoryTagStore();
    const model = new TagStoreDataModel(makeMap(), store);
    const resp = await processRequest(
      makeRequest(
        FunctionCode.READ_HOLDING_REGISTERS,
        Buffer.from([0x00, 0x32, 0x00, 0x01]), // addr 50, unmapped
      ),
      model,
    );
    const result = isException(resp);
    expect(result.exc).toBe(true);
    expect(result.code).toBe(ExceptionCode.ILLEGAL_DATA_ADDRESS);
  });
});
