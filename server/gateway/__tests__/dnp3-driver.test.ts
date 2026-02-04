/**
 * DNP3 Protocol Driver Tests
 *
 * Issue #81 - DNP3 Protocol Driver
 *
 * Tests for DNP3 data link layer, transport layer, application layer,
 * CRC calculation, address parsing, and driver functionality.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  // Constants
  DNP3FunctionCode,
  DNP3ObjectGroup,
  DNP3ObjectVariation,
  DNP3QualityFlag,
  DNP3InternalIndication,

  // CRC Functions
  calculateDNP3CRC,
  verifyDNP3CRC,

  // Address Parser
  parseDNP3Address,
  getObjectGroup,
  getDefaultVariation,

  // Protocol Layers
  DNP3DataLinkLayer,
  DNP3TransportLayer,
  DNP3ApplicationLayer,

  // Types
  type DNP3Address,
  type DNP3DataPoint,
  type DNP3DriverConfig,
  type DNP3ObjectHeader,

  // Driver
  DNP3TcpDriver,
  createDNP3Driver,
} from "../dnp3-driver";

// =============================================================================
// CRC-16 TESTS
// =============================================================================

describe("DNP3 CRC-16 Calculation", () => {
  describe("calculateDNP3CRC", () => {
    it("should calculate correct CRC for known data", () => {
      // DNP3 uses a specific polynomial (0xA6BC reflected)
      const data = Buffer.from([0x05, 0x64, 0x05, 0xc0, 0x01, 0x00, 0x00, 0x04]);
      const crc = calculateDNP3CRC(data);
      expect(crc).toBeDefined();
      expect(typeof crc).toBe("number");
      expect(crc).toBeGreaterThanOrEqual(0);
      expect(crc).toBeLessThanOrEqual(0xffff);
    });

    it("should produce consistent results", () => {
      const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const crc1 = calculateDNP3CRC(data);
      const crc2 = calculateDNP3CRC(data);
      expect(crc1).toBe(crc2);
    });

    it("should produce different CRCs for different data", () => {
      const data1 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const data2 = Buffer.from([0x01, 0x02, 0x03, 0x05]);
      expect(calculateDNP3CRC(data1)).not.toBe(calculateDNP3CRC(data2));
    });

    it("should handle empty buffer", () => {
      const data = Buffer.alloc(0);
      const crc = calculateDNP3CRC(data);
      expect(crc).toBeDefined();
    });

    it("should handle single byte", () => {
      const data = Buffer.from([0x55]);
      const crc = calculateDNP3CRC(data);
      expect(crc).toBeDefined();
      expect(crc).toBeGreaterThanOrEqual(0);
    });
  });

  describe("verifyDNP3CRC", () => {
    it("should verify correct CRC", () => {
      const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const crc = calculateDNP3CRC(data);
      expect(verifyDNP3CRC(data, crc)).toBe(true);
    });

    it("should reject incorrect CRC", () => {
      const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      expect(verifyDNP3CRC(data, 0x0000)).toBe(false);
      expect(verifyDNP3CRC(data, 0xffff)).toBe(false);
    });
  });
});

// =============================================================================
// ADDRESS PARSER TESTS
// =============================================================================

describe("DNP3 Address Parser", () => {
  describe("parseDNP3Address", () => {
    it("should parse Binary Input addresses", () => {
      expect(parseDNP3Address("BI:0")).toEqual({ type: "BINARY_INPUT", index: 0 });
      expect(parseDNP3Address("BI:100")).toEqual({ type: "BINARY_INPUT", index: 100 });
      expect(parseDNP3Address("BINARY_INPUT:5")).toEqual({ type: "BINARY_INPUT", index: 5 });
      expect(parseDNP3Address("1:10")).toEqual({ type: "BINARY_INPUT", index: 10 });
    });

    it("should parse Binary Output addresses", () => {
      expect(parseDNP3Address("BO:0")).toEqual({ type: "BINARY_OUTPUT", index: 0 });
      expect(parseDNP3Address("BO:50")).toEqual({ type: "BINARY_OUTPUT", index: 50 });
      expect(parseDNP3Address("BINARY_OUTPUT:3")).toEqual({ type: "BINARY_OUTPUT", index: 3 });
      expect(parseDNP3Address("10:5")).toEqual({ type: "BINARY_OUTPUT", index: 5 });
    });

    it("should parse Analog Input addresses", () => {
      expect(parseDNP3Address("AI:0")).toEqual({ type: "ANALOG_INPUT", index: 0 });
      expect(parseDNP3Address("AI:255")).toEqual({ type: "ANALOG_INPUT", index: 255 });
      expect(parseDNP3Address("ANALOG_INPUT:10")).toEqual({ type: "ANALOG_INPUT", index: 10 });
      expect(parseDNP3Address("30:15")).toEqual({ type: "ANALOG_INPUT", index: 15 });
    });

    it("should parse Analog Output addresses", () => {
      expect(parseDNP3Address("AO:0")).toEqual({ type: "ANALOG_OUTPUT", index: 0 });
      expect(parseDNP3Address("AO:20")).toEqual({ type: "ANALOG_OUTPUT", index: 20 });
      expect(parseDNP3Address("ANALOG_OUTPUT:8")).toEqual({ type: "ANALOG_OUTPUT", index: 8 });
      expect(parseDNP3Address("40:2")).toEqual({ type: "ANALOG_OUTPUT", index: 2 });
    });

    it("should parse Counter addresses", () => {
      expect(parseDNP3Address("CT:0")).toEqual({ type: "COUNTER", index: 0 });
      expect(parseDNP3Address("CT:32")).toEqual({ type: "COUNTER", index: 32 });
      expect(parseDNP3Address("COUNTER:5")).toEqual({ type: "COUNTER", index: 5 });
      expect(parseDNP3Address("20:7")).toEqual({ type: "COUNTER", index: 7 });
    });

    it("should parse Frozen Counter addresses", () => {
      expect(parseDNP3Address("FC:0")).toEqual({ type: "FROZEN_COUNTER", index: 0 });
      expect(parseDNP3Address("FC:16")).toEqual({ type: "FROZEN_COUNTER", index: 16 });
      expect(parseDNP3Address("FROZEN_COUNTER:3")).toEqual({ type: "FROZEN_COUNTER", index: 3 });
      expect(parseDNP3Address("21:9")).toEqual({ type: "FROZEN_COUNTER", index: 9 });
    });

    it("should be case-insensitive for type", () => {
      expect(parseDNP3Address("bi:5")).toEqual({ type: "BINARY_INPUT", index: 5 });
      expect(parseDNP3Address("Bi:5")).toEqual({ type: "BINARY_INPUT", index: 5 });
      expect(parseDNP3Address("BI:5")).toEqual({ type: "BINARY_INPUT", index: 5 });
    });

    it("should throw on invalid format", () => {
      expect(() => parseDNP3Address("invalid")).toThrow("Invalid DNP3 address format");
      expect(() => parseDNP3Address("")).toThrow();
      expect(() => parseDNP3Address("123")).toThrow();
    });

    it("should throw on unknown type", () => {
      expect(() => parseDNP3Address("XX:5")).toThrow("Unknown DNP3 point type");
      expect(() => parseDNP3Address("99:5")).toThrow("Unknown DNP3 point type");
    });

    it("should throw on invalid index", () => {
      expect(() => parseDNP3Address("BI:-1")).toThrow("Invalid DNP3 index");
      expect(() => parseDNP3Address("BI:abc")).toThrow("Invalid DNP3 index");
    });
  });

  describe("getObjectGroup", () => {
    it("should return correct object groups", () => {
      expect(getObjectGroup("BINARY_INPUT")).toBe(DNP3ObjectGroup.BINARY_INPUT);
      expect(getObjectGroup("BINARY_OUTPUT")).toBe(DNP3ObjectGroup.BINARY_OUTPUT);
      expect(getObjectGroup("ANALOG_INPUT")).toBe(DNP3ObjectGroup.ANALOG_INPUT);
      expect(getObjectGroup("ANALOG_OUTPUT")).toBe(DNP3ObjectGroup.ANALOG_OUTPUT_STATUS);
      expect(getObjectGroup("COUNTER")).toBe(DNP3ObjectGroup.COUNTER);
      expect(getObjectGroup("FROZEN_COUNTER")).toBe(DNP3ObjectGroup.FROZEN_COUNTER);
    });

    it("should throw on unknown type", () => {
      expect(() => getObjectGroup("UNKNOWN" as any)).toThrow();
    });
  });

  describe("getDefaultVariation", () => {
    it("should return correct default variations", () => {
      expect(getDefaultVariation("BINARY_INPUT")).toBe(DNP3ObjectVariation.BINARY_INPUT_FLAGS);
      expect(getDefaultVariation("BINARY_OUTPUT")).toBe(DNP3ObjectVariation.BINARY_OUTPUT_FLAGS);
      expect(getDefaultVariation("ANALOG_INPUT")).toBe(DNP3ObjectVariation.ANALOG_INPUT_32BIT_FLAGS);
      expect(getDefaultVariation("ANALOG_OUTPUT")).toBe(DNP3ObjectVariation.ANALOG_OUTPUT_32BIT_FLAGS);
      expect(getDefaultVariation("COUNTER")).toBe(DNP3ObjectVariation.COUNTER_32BIT_FLAGS);
      expect(getDefaultVariation("FROZEN_COUNTER")).toBe(DNP3ObjectVariation.COUNTER_32BIT_FLAGS);
    });
  });
});

// =============================================================================
// DATA LINK LAYER TESTS
// =============================================================================

describe("DNP3 Data Link Layer", () => {
  let dataLinkLayer: DNP3DataLinkLayer;

  beforeEach(() => {
    dataLinkLayer = new DNP3DataLinkLayer(1, 10); // Master=1, Outstation=10
  });

  describe("buildFrame", () => {
    it("should build frame with correct start bytes", () => {
      const userData = Buffer.from([0x01, 0x02]);
      const frame = dataLinkLayer.buildFrame(userData);

      // Start bytes should be 0x0564
      expect(frame.readUInt16LE(0)).toBe(0x0564);
    });

    it("should include correct length field", () => {
      const userData = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const frame = dataLinkLayer.buildFrame(userData);

      // Length = userData + 5 (control + addresses)
      expect(frame.readUInt8(2)).toBe(userData.length + 5);
    });

    it("should set correct control byte for master to outstation", () => {
      const userData = Buffer.from([0x01]);
      const frame = dataLinkLayer.buildFrame(userData, "MASTER_TO_OUTSTATION", true);

      const control = frame.readUInt8(3);
      // DIR bit should be set (0x80), PRM bit should be set (0x40)
      expect(control & 0x80).toBe(0x80); // Direction
      expect(control & 0x40).toBe(0x40); // Primary
    });

    it("should include destination and source addresses", () => {
      const userData = Buffer.from([0x01]);
      const frame = dataLinkLayer.buildFrame(userData, "MASTER_TO_OUTSTATION");

      // Destination (outstation) at offset 4
      expect(frame.readUInt16LE(4)).toBe(10);
      // Source (master) at offset 6
      expect(frame.readUInt16LE(6)).toBe(1);
    });

    it("should include header CRC", () => {
      const userData = Buffer.from([0x01]);
      const frame = dataLinkLayer.buildFrame(userData);

      // Header CRC is at offset 8-9
      const headerData = frame.subarray(0, 8);
      const headerCRC = frame.readUInt16LE(8);
      expect(verifyDNP3CRC(headerData, headerCRC)).toBe(true);
    });

    it("should include user data CRC blocks", () => {
      const userData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const frame = dataLinkLayer.buildFrame(userData);

      // User data starts at offset 10
      // First block should be the user data, then CRC
      const block = frame.subarray(10, 10 + userData.length);
      const blockCRC = frame.readUInt16LE(10 + userData.length);
      expect(verifyDNP3CRC(block, blockCRC)).toBe(true);
    });
  });

  describe("parseData", () => {
    it("should parse valid frame", () => {
      const userData = Buffer.from([0x01, 0x02, 0x03]);
      const frame = dataLinkLayer.buildFrame(userData, "OUTSTATION_TO_MASTER");

      // Parse as if receiving from outstation
      const dlLayer = new DNP3DataLinkLayer(1, 10);
      const frames = dlLayer.parseData(frame);

      expect(frames.length).toBe(1);
      expect(frames[0].userData).toBeDefined();
      expect(frames[0].userData!.length).toBe(userData.length);
    });

    it("should handle fragmented data", () => {
      const userData = Buffer.from([0x01, 0x02, 0x03]);
      const frame = dataLinkLayer.buildFrame(userData, "OUTSTATION_TO_MASTER");

      const dlLayer = new DNP3DataLinkLayer(1, 10);

      // Send first half
      const firstHalf = frame.subarray(0, Math.floor(frame.length / 2));
      let frames = dlLayer.parseData(firstHalf);
      expect(frames.length).toBe(0);

      // Send second half
      const secondHalf = frame.subarray(Math.floor(frame.length / 2));
      frames = dlLayer.parseData(secondHalf);
      expect(frames.length).toBe(1);
    });

    it("should reject invalid CRC", () => {
      const userData = Buffer.from([0x01, 0x02, 0x03]);
      const frame = dataLinkLayer.buildFrame(userData, "OUTSTATION_TO_MASTER");

      // Corrupt the header CRC
      frame.writeUInt16LE(0x0000, 8);

      const dlLayer = new DNP3DataLinkLayer(1, 10);
      const frames = dlLayer.parseData(frame);

      // Should skip invalid frame
      expect(frames.length).toBe(0);
    });

    it("should handle multiple frames", () => {
      const userData1 = Buffer.from([0x01]);
      const userData2 = Buffer.from([0x02]);
      const frame1 = dataLinkLayer.buildFrame(userData1, "OUTSTATION_TO_MASTER");
      const frame2 = dataLinkLayer.buildFrame(userData2, "OUTSTATION_TO_MASTER");

      const combined = Buffer.concat([frame1, frame2]);

      const dlLayer = new DNP3DataLinkLayer(1, 10);
      const frames = dlLayer.parseData(combined);

      expect(frames.length).toBe(2);
    });
  });
});

// =============================================================================
// TRANSPORT LAYER TESTS
// =============================================================================

describe("DNP3 Transport Layer", () => {
  let transportLayer: DNP3TransportLayer;

  beforeEach(() => {
    transportLayer = new DNP3TransportLayer();
  });

  describe("segmentData", () => {
    it("should create single segment for small data", () => {
      const data = Buffer.from([0x01, 0x02, 0x03]);
      const segments = transportLayer.segmentData(data);

      expect(segments.length).toBe(1);
      expect(segments[0].fir).toBe(true);
      expect(segments[0].fin).toBe(true);
      expect(segments[0].data.length).toBe(data.length);
    });

    it("should create multiple segments for large data", () => {
      // Create data larger than max segment size (249 bytes)
      const data = Buffer.alloc(500);
      const segments = transportLayer.segmentData(data);

      expect(segments.length).toBeGreaterThan(1);
      expect(segments[0].fir).toBe(true);
      expect(segments[0].fin).toBe(false);
      expect(segments[segments.length - 1].fir).toBe(false);
      expect(segments[segments.length - 1].fin).toBe(true);
    });

    it("should increment sequence numbers", () => {
      const data = Buffer.alloc(500);
      const segments = transportLayer.segmentData(data);

      for (let i = 1; i < segments.length; i++) {
        const expectedSeq = (segments[0].sequence + i) & 0x3f;
        expect(segments[i].sequence).toBe(expectedSeq);
      }
    });
  });

  describe("buildSegment", () => {
    it("should build segment with correct header", () => {
      const segment = {
        fir: true,
        fin: true,
        sequence: 5,
        data: Buffer.from([0x01, 0x02]),
      };

      const built = transportLayer.buildSegment(segment);

      const header = built.readUInt8(0);
      expect(header & 0x3f).toBe(5); // Sequence
      expect(header & 0x40).toBe(0x40); // FIR
      expect(header & 0x80).toBe(0x80); // FIN
    });

    it("should include data after header", () => {
      const segment = {
        fir: true,
        fin: true,
        sequence: 0,
        data: Buffer.from([0xaa, 0xbb, 0xcc]),
      };

      const built = transportLayer.buildSegment(segment);

      expect(built.subarray(1)).toEqual(segment.data);
    });
  });

  describe("processSegment", () => {
    it("should reassemble single segment message", () => {
      const data = Buffer.from([0xc0, 0x01, 0x02, 0x03]); // FIR=1, FIN=1
      const message = transportLayer.processSegment(data);

      expect(message).not.toBeNull();
      expect(message!.length).toBe(3); // Without header
    });

    it("should reassemble multi-segment message", () => {
      // First segment (FIR=1, FIN=0, SEQ=0)
      const seg1 = Buffer.from([0x40, 0xaa, 0xbb]);
      let message = transportLayer.processSegment(seg1);
      expect(message).toBeNull();

      // Middle segment (FIR=0, FIN=0, SEQ=1)
      const seg2 = Buffer.from([0x01, 0xcc, 0xdd]);
      message = transportLayer.processSegment(seg2);
      expect(message).toBeNull();

      // Final segment (FIR=0, FIN=1, SEQ=2)
      const seg3 = Buffer.from([0x82, 0xee, 0xff]);
      message = transportLayer.processSegment(seg3);

      expect(message).not.toBeNull();
      expect(message!.length).toBe(6);
    });

    it("should reset on sequence error", () => {
      // First segment (FIR=1, FIN=0, SEQ=0)
      const seg1 = Buffer.from([0x40, 0xaa, 0xbb]);
      transportLayer.processSegment(seg1);

      // Wrong sequence (expected 1, got 5)
      const seg2 = Buffer.from([0x05, 0xcc, 0xdd]);
      const message = transportLayer.processSegment(seg2);

      expect(message).toBeNull();
    });
  });
});

// =============================================================================
// APPLICATION LAYER TESTS
// =============================================================================

describe("DNP3 Application Layer", () => {
  let applicationLayer: DNP3ApplicationLayer;

  beforeEach(() => {
    applicationLayer = new DNP3ApplicationLayer();
  });

  describe("buildReadRequest", () => {
    it("should build read request with correct function code", () => {
      const request = applicationLayer.buildReadRequest([
        { group: DNP3ObjectGroup.BINARY_INPUT, variation: 2 },
      ]);

      expect(request.readUInt8(1)).toBe(DNP3FunctionCode.READ);
    });

    it("should include FIR and FIN flags", () => {
      const request = applicationLayer.buildReadRequest([
        { group: DNP3ObjectGroup.ANALOG_INPUT, variation: 1 },
      ]);

      const appControl = request.readUInt8(0);
      expect(appControl & 0xc0).toBe(0xc0); // FIR=1, FIN=1
    });

    it("should increment sequence number", () => {
      const request1 = applicationLayer.buildReadRequest([
        { group: 1, variation: 1 },
      ]);
      const request2 = applicationLayer.buildReadRequest([
        { group: 1, variation: 1 },
      ]);

      const seq1 = request1.readUInt8(0) & 0x0f;
      const seq2 = request2.readUInt8(0) & 0x0f;
      expect(seq2).toBe((seq1 + 1) & 0x0f);
    });

    it("should include object headers", () => {
      const request = applicationLayer.buildReadRequest([
        { group: 30, variation: 1 },
        { group: 20, variation: 5 },
      ]);

      // After app control and function code, we should have object headers
      expect(request.readUInt8(2)).toBe(30); // First group
      expect(request.readUInt8(3)).toBe(1); // First variation
    });
  });

  describe("buildIntegrityPollRequest", () => {
    it("should request all class data", () => {
      const request = applicationLayer.buildIntegrityPollRequest();

      // Should contain Class 3, 2, 1, 0 requests (Group 60)
      expect(request.readUInt8(1)).toBe(DNP3FunctionCode.READ);

      // Look for Group 60 objects
      let offset = 2;
      let foundGroup60 = false;
      while (offset < request.length - 2) {
        if (request.readUInt8(offset) === 60) {
          foundGroup60 = true;
          break;
        }
        offset += 3; // Min object header size
      }
      expect(foundGroup60).toBe(true);
    });
  });

  describe("buildDirectOperateRequest", () => {
    it("should build CROB for binary output", () => {
      const crob = {
        controlCode: 0x03, // Latch On
        count: 1,
        onTime: 0,
        offTime: 0,
        status: 0,
      };

      const request = applicationLayer.buildDirectOperateRequest(
        DNP3ObjectGroup.BINARY_OUTPUT_COMMAND,
        1,
        5,
        crob
      );

      expect(request.readUInt8(1)).toBe(DNP3FunctionCode.DIRECT_OPERATE);
      expect(request.readUInt8(2)).toBe(DNP3ObjectGroup.BINARY_OUTPUT_COMMAND);
    });

    it("should build analog output request", () => {
      const request = applicationLayer.buildDirectOperateRequest(
        DNP3ObjectGroup.ANALOG_OUTPUT_COMMAND,
        1,
        3,
        12345
      );

      expect(request.readUInt8(1)).toBe(DNP3FunctionCode.DIRECT_OPERATE);
      expect(request.readUInt8(2)).toBe(DNP3ObjectGroup.ANALOG_OUTPUT_COMMAND);
    });
  });

  describe("buildUnsolicitedRequest", () => {
    it("should build enable unsolicited request", () => {
      const request = applicationLayer.buildUnsolicitedRequest(true);

      expect(request.readUInt8(1)).toBe(DNP3FunctionCode.ENABLE_UNSOLICITED);
    });

    it("should build disable unsolicited request", () => {
      const request = applicationLayer.buildUnsolicitedRequest(false);

      expect(request.readUInt8(1)).toBe(DNP3FunctionCode.DISABLE_UNSOLICITED);
    });
  });

  describe("buildConfirmation", () => {
    it("should build confirmation with correct sequence", () => {
      const confirm = applicationLayer.buildConfirmation(5);

      expect(confirm.readUInt8(0) & 0x0f).toBe(5);
      expect(confirm.readUInt8(1)).toBe(DNP3FunctionCode.CONFIRM);
    });
  });

  describe("parseResponse", () => {
    it("should parse response header", () => {
      // Build a mock response: AppControl, FuncCode, IIN1, IIN2, objects...
      const response = Buffer.from([
        0xc5, // App control: FIR=1, FIN=1, SEQ=5
        0x81, // Function code: Response
        0x00, // IIN1
        0x00, // IIN2
      ]);

      const parsed = applicationLayer.parseResponse(response);

      expect(parsed).not.toBeNull();
      expect(parsed!.applicationControl).toBe(0xc5);
      expect(parsed!.functionCode).toBe(DNP3FunctionCode.RESPONSE);
      expect(parsed!.internalIndications).toBe(0x0000);
    });

    it("should parse internal indications", () => {
      const response = Buffer.from([
        0xc0,
        0x81,
        0x82, // IIN1: Class 1 events, device restart
        0x01, // IIN2: No func code support
      ]);

      const parsed = applicationLayer.parseResponse(response);

      expect(parsed!.internalIndications! & DNP3InternalIndication.CLASS_1_EVENTS).toBeTruthy();
      expect(parsed!.internalIndications! & DNP3InternalIndication.DEVICE_RESTART).toBeTruthy();
      expect(parsed!.internalIndications! & DNP3InternalIndication.NO_FUNC_CODE_SUPPORT).toBeTruthy();
    });

    it("should return null for short data", () => {
      const response = Buffer.from([0xc0, 0x81]);
      const parsed = applicationLayer.parseResponse(response);
      expect(parsed).toBeNull();
    });
  });
});

// =============================================================================
// DNP3 CONSTANTS TESTS
// =============================================================================

describe("DNP3 Constants", () => {
  describe("Function Codes", () => {
    it("should have correct request function codes", () => {
      expect(DNP3FunctionCode.READ).toBe(0x01);
      expect(DNP3FunctionCode.WRITE).toBe(0x02);
      expect(DNP3FunctionCode.DIRECT_OPERATE).toBe(0x05);
      expect(DNP3FunctionCode.ENABLE_UNSOLICITED).toBe(0x14);
      expect(DNP3FunctionCode.DISABLE_UNSOLICITED).toBe(0x15);
    });

    it("should have correct response function codes", () => {
      expect(DNP3FunctionCode.RESPONSE).toBe(0x81);
      expect(DNP3FunctionCode.UNSOLICITED_RESPONSE).toBe(0x82);
    });
  });

  describe("Object Groups", () => {
    it("should have correct binary input/output groups", () => {
      expect(DNP3ObjectGroup.BINARY_INPUT).toBe(1);
      expect(DNP3ObjectGroup.BINARY_INPUT_EVENT).toBe(2);
      expect(DNP3ObjectGroup.BINARY_OUTPUT).toBe(10);
      expect(DNP3ObjectGroup.BINARY_OUTPUT_COMMAND).toBe(12);
    });

    it("should have correct analog groups", () => {
      expect(DNP3ObjectGroup.ANALOG_INPUT).toBe(30);
      expect(DNP3ObjectGroup.ANALOG_INPUT_EVENT).toBe(32);
      expect(DNP3ObjectGroup.ANALOG_OUTPUT_STATUS).toBe(40);
      expect(DNP3ObjectGroup.ANALOG_OUTPUT_COMMAND).toBe(41);
    });

    it("should have correct counter groups", () => {
      expect(DNP3ObjectGroup.COUNTER).toBe(20);
      expect(DNP3ObjectGroup.FROZEN_COUNTER).toBe(21);
      expect(DNP3ObjectGroup.COUNTER_EVENT).toBe(22);
    });

    it("should have correct class data group", () => {
      expect(DNP3ObjectGroup.CLASS_0).toBe(60);
    });
  });

  describe("Quality Flags", () => {
    it("should have correct flag values", () => {
      expect(DNP3QualityFlag.ONLINE).toBe(0x01);
      expect(DNP3QualityFlag.RESTART).toBe(0x02);
      expect(DNP3QualityFlag.COMM_LOST).toBe(0x04);
      expect(DNP3QualityFlag.REMOTE_FORCED).toBe(0x08);
      expect(DNP3QualityFlag.LOCAL_FORCED).toBe(0x10);
      expect(DNP3QualityFlag.OVER_RANGE).toBe(0x20);
      expect(DNP3QualityFlag.REFERENCE_ERR).toBe(0x40);
    });
  });

  describe("Internal Indication Flags", () => {
    it("should have correct IIN1 flags", () => {
      expect(DNP3InternalIndication.ALL_STATIONS).toBe(0x0001);
      expect(DNP3InternalIndication.CLASS_1_EVENTS).toBe(0x0002);
      expect(DNP3InternalIndication.CLASS_2_EVENTS).toBe(0x0004);
      expect(DNP3InternalIndication.CLASS_3_EVENTS).toBe(0x0008);
      expect(DNP3InternalIndication.NEED_TIME).toBe(0x0010);
      expect(DNP3InternalIndication.LOCAL_CONTROL).toBe(0x0020);
      expect(DNP3InternalIndication.DEVICE_TROUBLE).toBe(0x0040);
      expect(DNP3InternalIndication.DEVICE_RESTART).toBe(0x0080);
    });

    it("should have correct IIN2 flags", () => {
      expect(DNP3InternalIndication.NO_FUNC_CODE_SUPPORT).toBe(0x0100);
      expect(DNP3InternalIndication.OBJECT_UNKNOWN).toBe(0x0200);
      expect(DNP3InternalIndication.PARAMETER_ERROR).toBe(0x0400);
      expect(DNP3InternalIndication.EVENT_BUFFER_OVERFLOW).toBe(0x0800);
    });
  });
});

// =============================================================================
// DNP3 TCP DRIVER TESTS
// =============================================================================

describe("DNP3 TCP Driver", () => {
  describe("createDNP3Driver", () => {
    it("should create driver with default config", () => {
      const driver = createDNP3Driver("127.0.0.1");

      const status = driver.getStatus();
      expect(status.host).toBe("127.0.0.1");
      expect(status.port).toBe(20000);
      expect(status.masterAddress).toBe(1);
      expect(status.outstationAddress).toBe(10);
    });

    it("should create driver with custom config", () => {
      const driver = createDNP3Driver("192.168.1.100", 10000, 3, 15);

      const status = driver.getStatus();
      expect(status.host).toBe("192.168.1.100");
      expect(status.port).toBe(10000);
      expect(status.masterAddress).toBe(3);
      expect(status.outstationAddress).toBe(15);
    });
  });

  describe("DNP3TcpDriver", () => {
    let driver: DNP3TcpDriver;

    beforeEach(() => {
      driver = new DNP3TcpDriver({
        host: "127.0.0.1",
        port: 20000,
        masterAddress: 1,
        outstationAddress: 10,
        timeout: 5000,
        retryCount: 3,
        retryDelay: 1000,
        enableUnsolicited: false,
        pollInterval: 1000,
        integrityPollInterval: 60000,
      });
    });

    afterEach(async () => {
      if (driver.isConnected()) {
        await driver.disconnect();
      }
    });

    it("should have correct protocol type", () => {
      expect(driver.protocol).toBe("DNP3_TCP");
    });

    it("should report not connected initially", () => {
      expect(driver.isConnected()).toBe(false);
    });

    it("should return correct status", () => {
      const status = driver.getStatus();

      expect(status.protocol).toBe("DNP3_TCP");
      expect(status.host).toBe("127.0.0.1");
      expect(status.port).toBe(20000);
      expect(status.connected).toBe(false);
      expect(status.subscribedTags).toBe(0);
    });

    it("should parse internal indications correctly", () => {
      const iin = 0x0082; // Device restart + Class 1 events

      const result = driver.getInternalIndications(iin);

      expect(result.deviceRestart).toBe(true);
      expect(result.class1Events).toBe(true);
      expect(result.class2Events).toBe(false);
      expect(result.needTime).toBe(false);
    });

    it("should start with empty data points", () => {
      const points = driver.getAllDataPoints();
      expect(points.size).toBe(0);
    });
  });
});

// =============================================================================
// INTEGRATION TESTS (with mocked socket)
// =============================================================================

describe("DNP3 Driver Integration", () => {
  // These tests verify the full protocol stack works together
  // without actually connecting to a network

  it("should build and parse complete message through all layers", () => {
    const masterAddr = 1;
    const outstationAddr = 10;

    const dataLink = new DNP3DataLinkLayer(masterAddr, outstationAddr);
    const transport = new DNP3TransportLayer();
    const application = new DNP3ApplicationLayer();

    // Build read request
    const appData = application.buildReadRequest([
      { group: DNP3ObjectGroup.BINARY_INPUT, variation: 2, range: { startIndex: 0, stopIndex: 9 } },
    ]);

    // Segment through transport layer
    const segments = transport.segmentData(appData);
    expect(segments.length).toBe(1);

    // Build transport segment
    const transportData = transport.buildSegment(segments[0]);

    // Build data link frame
    const frame = dataLink.buildFrame(transportData, "MASTER_TO_OUTSTATION");

    // Verify frame structure
    expect(frame.readUInt16LE(0)).toBe(0x0564);
    expect(frame.length).toBeGreaterThan(10);

    // Parse frame back
    const parsedFrames = dataLink.parseData(frame);
    expect(parsedFrames.length).toBe(1);

    // Process transport
    const newTransport = new DNP3TransportLayer();
    const message = newTransport.processSegment(parsedFrames[0].userData!);
    expect(message).not.toBeNull();

    // Verify application data
    expect(message!.readUInt8(1)).toBe(DNP3FunctionCode.READ);
  });

  it("should correctly build integrity poll request", () => {
    const application = new DNP3ApplicationLayer();
    const request = application.buildIntegrityPollRequest();

    // Verify structure
    expect(request.readUInt8(0) & 0xc0).toBe(0xc0); // FIR and FIN
    expect(request.readUInt8(1)).toBe(DNP3FunctionCode.READ);

    // Should contain class objects (Group 60)
    expect(request.indexOf(Buffer.from([60]))).toBeGreaterThan(1);
  });
});
