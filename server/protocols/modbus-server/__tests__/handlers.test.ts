/**
 * Handler tests (#462): each function-code handler + each exception case.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  EXCEPTION_FLAG,
  ExceptionCode,
  FunctionCode,
  decodeRequest,
  type ModbusRequest,
} from "../codec";
import { processRequest } from "../handlers";
import { InMemoryDataModel, type ModbusDataModel } from "../data-model";

function makeRequest(fc: number, data: Buffer, unitId = 1): ModbusRequest {
  return {
    header: { transactionId: 0x42, protocolId: 0, length: 0, unitId },
    functionCode: fc,
    data,
  };
}

/** Parse a response frame buffer into { fc, isException, body }. */
function parseResponse(buf: Buffer): {
  fc: number;
  isException: boolean;
  body: Buffer;
  transactionId: number;
} {
  const decoded = decodeRequest(buf)!;
  const rawFc = decoded.request.functionCode;
  return {
    fc: rawFc & ~EXCEPTION_FLAG,
    isException: (rawFc & EXCEPTION_FLAG) !== 0,
    body: decoded.request.data,
    transactionId: decoded.request.header.transactionId,
  };
}

describe("read function codes", () => {
  let model: InMemoryDataModel;

  beforeEach(() => {
    model = new InMemoryDataModel({
      coils: 100,
      discreteInputs: 100,
      holdingRegisters: 100,
      inputRegisters: 100,
    });
  });

  it("FC01 Read Coils returns packed coil bits", async () => {
    await model.writeCoils(0, [true, false, true]); // bits 0,2 set
    const data = Buffer.from([0x00, 0x00, 0x00, 0x03]); // addr 0, qty 3
    const resp = parseResponse(
      await processRequest(makeRequest(FunctionCode.READ_COILS, data), model),
    );
    expect(resp.isException).toBe(false);
    expect(resp.fc).toBe(FunctionCode.READ_COILS);
    expect(resp.body.readUInt8(0)).toBe(1); // byte count
    expect(resp.body.readUInt8(1)).toBe(0b00000101);
    expect(resp.transactionId).toBe(0x42); // echoes request transaction id
  });

  it("FC02 Read Discrete Inputs returns packed bits", async () => {
    model.setDiscreteInput(1, true);
    const data = Buffer.from([0x00, 0x00, 0x00, 0x02]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_DISCRETE_INPUTS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(false);
    expect(resp.body.readUInt8(1)).toBe(0b00000010); // bit 1 set
  });

  it("FC03 Read Holding Registers returns big-endian words", async () => {
    await model.writeHoldingRegisters(10, [0x1234, 0xabcd]);
    const data = Buffer.from([0x00, 0x0a, 0x00, 0x02]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_HOLDING_REGISTERS, data),
        model,
      ),
    );
    expect(resp.body.readUInt8(0)).toBe(4); // byte count = qty*2
    expect(resp.body.readUInt16BE(1)).toBe(0x1234);
    expect(resp.body.readUInt16BE(3)).toBe(0xabcd);
  });

  it("FC04 Read Input Registers returns values", async () => {
    model.setInputRegister(5, 0x00ff);
    const data = Buffer.from([0x00, 0x05, 0x00, 0x01]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_INPUT_REGISTERS, data),
        model,
      ),
    );
    expect(resp.body.readUInt16BE(1)).toBe(0x00ff);
  });
});

describe("write function codes", () => {
  let model: InMemoryDataModel;

  beforeEach(() => {
    model = new InMemoryDataModel({
      coils: 100,
      holdingRegisters: 100,
    });
  });

  it("FC05 Write Single Coil ON writes and echoes the request", async () => {
    const data = Buffer.from([0x00, 0x03, 0xff, 0x00]); // addr 3, ON
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_SINGLE_COIL, data),
        model,
      ),
    );
    expect(resp.isException).toBe(false);
    expect(resp.body.equals(data)).toBe(true);
    expect(await model.readCoils(3, 1)).toEqual([true]);
  });

  it("FC05 rejects an invalid coil value with Illegal Data Value", async () => {
    const data = Buffer.from([0x00, 0x03, 0x12, 0x34]); // not 0x0000/0xFF00
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_SINGLE_COIL, data),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_VALUE);
  });

  it("FC06 Write Single Register writes and echoes", async () => {
    const data = Buffer.from([0x00, 0x07, 0xbe, 0xef]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_SINGLE_REGISTER, data),
        model,
      ),
    );
    expect(resp.body.equals(data)).toBe(true);
    expect(await model.readHoldingRegisters(7, 1)).toEqual([0xbeef]);
  });

  it("FC15 Write Multiple Coils writes the bit pattern", async () => {
    // addr 0, qty 5, byteCount 1, value 0b00010011 (bits 0,1,4)
    const data = Buffer.from([0x00, 0x00, 0x00, 0x05, 0x01, 0b00010011]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_MULTIPLE_COILS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(false);
    // response = starting address + quantity
    expect(resp.body.readUInt16BE(0)).toBe(0);
    expect(resp.body.readUInt16BE(2)).toBe(5);
    expect(await model.readCoils(0, 5)).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it("FC15 rejects a mismatched byte count", async () => {
    // qty 5 needs ceil(5/8)=1 byte, declare 2
    const data = Buffer.from([0x00, 0x00, 0x00, 0x05, 0x02, 0x01, 0x00]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_MULTIPLE_COILS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_VALUE);
  });

  it("FC16 Write Multiple Registers writes the words", async () => {
    // addr 20, qty 2, byteCount 4, words 0x1111 0x2222
    const data = Buffer.from([
      0x00, 0x14, 0x00, 0x02, 0x04, 0x11, 0x11, 0x22, 0x22,
    ]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_MULTIPLE_REGISTERS, data),
        model,
      ),
    );
    expect(resp.body.readUInt16BE(0)).toBe(20);
    expect(resp.body.readUInt16BE(2)).toBe(2);
    expect(await model.readHoldingRegisters(20, 2)).toEqual([0x1111, 0x2222]);
  });

  it("FC16 rejects byteCount != quantity*2", async () => {
    const data = Buffer.from([0x00, 0x14, 0x00, 0x02, 0x02, 0x11, 0x11]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.WRITE_MULTIPLE_REGISTERS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_VALUE);
  });
});

describe("exception cases", () => {
  it("returns Illegal Function (0x01) for an unsupported FC", async () => {
    const model = new InMemoryDataModel();
    const resp = parseResponse(
      await processRequest(makeRequest(0x63, Buffer.alloc(4)), model),
    );
    expect(resp.isException).toBe(true);
    expect(resp.fc).toBe(0x63);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_FUNCTION);
  });

  it("returns Illegal Data Address (0x02) for an out-of-range read", async () => {
    const model = new InMemoryDataModel({ holdingRegisters: 10 });
    const data = Buffer.from([0x00, 0x09, 0x00, 0x05]); // 9..14 > size 10
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_HOLDING_REGISTERS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_ADDRESS);
  });

  it("returns Illegal Data Value (0x03) for quantity 0", async () => {
    const model = new InMemoryDataModel({ holdingRegisters: 10 });
    const data = Buffer.from([0x00, 0x00, 0x00, 0x00]); // qty 0
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_HOLDING_REGISTERS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_VALUE);
  });

  it("returns Illegal Data Value (0x03) for quantity over the cap", async () => {
    const model = new InMemoryDataModel();
    const data = Buffer.from([0x00, 0x00, 0x00, 0x7e]); // 126 > 125
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_HOLDING_REGISTERS, data),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_VALUE);
  });

  it("returns Server Device Failure (0x04) when the model throws unexpectedly", async () => {
    const failing: ModbusDataModel = {
      readCoils: () => Promise.reject(new Error("boom")),
      readDiscreteInputs: () => Promise.reject(new Error("boom")),
      readHoldingRegisters: () => Promise.reject(new Error("boom")),
      readInputRegisters: () => Promise.reject(new Error("boom")),
      writeCoils: () => Promise.reject(new Error("boom")),
      writeHoldingRegisters: () => Promise.reject(new Error("boom")),
    };
    const data = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_HOLDING_REGISTERS, data),
        failing,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.SERVER_DEVICE_FAILURE);
  });

  it("returns Illegal Data Value for a truncated PDU", async () => {
    const model = new InMemoryDataModel();
    const resp = parseResponse(
      await processRequest(
        makeRequest(FunctionCode.READ_HOLDING_REGISTERS, Buffer.from([0x00])),
        model,
      ),
    );
    expect(resp.isException).toBe(true);
    expect(resp.body.readUInt8(0)).toBe(ExceptionCode.ILLEGAL_DATA_VALUE);
  });
});

describe("response framing", () => {
  it("preserves transaction id and unit id in the response MBAP header", async () => {
    const model = new InMemoryDataModel({ holdingRegisters: 10 });
    const req = makeRequest(
      FunctionCode.READ_HOLDING_REGISTERS,
      Buffer.from([0x00, 0x00, 0x00, 0x01]),
      0x09,
    );
    req.header.transactionId = 0xbeef;
    const buf = await processRequest(req, model);
    expect(buf.readUInt16BE(0)).toBe(0xbeef); // transaction id
    expect(buf.readUInt8(6)).toBe(0x09); // unit id
    expect(buf.readUInt16BE(2)).toBe(0); // protocol id
  });
});
