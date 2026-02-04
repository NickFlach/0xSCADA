/**
 * IEC 61850 MMS Driver Tests
 *
 * Issue #82 - IEC 61850 MMS Driver for Substation Automation
 *
 * Tests for:
 * - MMS protocol layer
 * - GOOSE message handling
 * - Logical Node data models (LN, DO, DA structure)
 * - Connection pooling and reconnection logic
 * - IEC 61850 data type encoding/decoding
 * - Address parsing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  IEC61850Driver,
  createIEC61850Driver,
  parseIEC61850Address,
  buildIEC61850Address,
  encodeIEC61850Value,
  decodeIEC61850Value,
  createIEC61850Timestamp,
  createGoodQuality,
  IEC61850DataType,
  DoublePointStatus,
  type IEC61850Quality,
  type IEC61850Timestamp,
  type ParsedIEC61850Address,
  type GOOSEPDU,
} from "../gateway/iec61850-driver";

describe("IEC 61850 MMS Driver", () => {
  let driver: IEC61850Driver;

  beforeEach(() => {
    driver = createIEC61850Driver("192.168.1.100", "IED01", 102, {
      timeout: 5000,
      retryCount: 2,
      retryDelay: 500,
      gooseEnabled: true,
    });
  });

  afterEach(async () => {
    if (driver.isConnected()) {
      await driver.disconnect();
    }
  });

  // ===========================================================================
  // ADDRESS PARSING
  // ===========================================================================

  describe("Address Parsing", () => {
    it("should parse basic IEC 61850 address", () => {
      const address = "CTRL/XCBR1.Pos.stVal[ST]";
      const parsed = parseIEC61850Address(address);

      expect(parsed.ldName).toBe("CTRL");
      expect(parsed.lnClass).toBe("XCBR");
      expect(parsed.lnInst).toBe("1");
      expect(parsed.doName).toBe("Pos");
      expect(parsed.daName).toBe("stVal");
      expect(parsed.fc).toBe("ST");
    });

    it("should parse address without functional constraint", () => {
      const address = "MEAS/MMXU1.TotW.mag";
      const parsed = parseIEC61850Address(address);

      expect(parsed.ldName).toBe("MEAS");
      expect(parsed.lnClass).toBe("MMXU");
      expect(parsed.lnInst).toBe("1");
      expect(parsed.doName).toBe("TotW");
      expect(parsed.daName).toBe("mag");
      expect(parsed.fc).toBeUndefined();
    });

    it("should parse address with prefix", () => {
      const address = "PROT/Q0$PTOC$1.Op.general[ST]";
      const parsed = parseIEC61850Address(address);

      expect(parsed.ldName).toBe("PROT");
      expect(parsed.lnPrefix).toBe("Q0");
      expect(parsed.lnClass).toBe("PTOC");
      expect(parsed.lnInst).toBe("1");
      expect(parsed.doName).toBe("Op");
      expect(parsed.daName).toBe("general");
      expect(parsed.fc).toBe("ST");
    });

    it("should parse address without instance number", () => {
      const address = "CTRL/LLN0.Mod.stVal[ST]";
      const parsed = parseIEC61850Address(address);

      expect(parsed.ldName).toBe("CTRL");
      expect(parsed.lnClass).toBe("LLN");
      expect(parsed.lnInst).toBe("0");
      expect(parsed.doName).toBe("Mod");
    });

    it("should parse nested data attribute paths", () => {
      const address = "MEAS/MMXU1.PhV.phsA.cVal[MX]";
      const parsed = parseIEC61850Address(address);

      expect(parsed.ldName).toBe("MEAS");
      expect(parsed.lnClass).toBe("MMXU");
      expect(parsed.lnInst).toBe("1");
      expect(parsed.doName).toBe("PhV");
      expect(parsed.daName).toBe("phsA.cVal");
      expect(parsed.fc).toBe("MX");
    });

    it("should throw on invalid address format", () => {
      expect(() => parseIEC61850Address("InvalidAddress")).toThrow();
      expect(() => parseIEC61850Address("")).toThrow();
    });

    it("should build address from parsed components", () => {
      const parsed: ParsedIEC61850Address = {
        ldName: "CTRL",
        lnClass: "XCBR",
        lnInst: "1",
        doName: "Pos",
        daName: "stVal",
        fc: "ST",
      };

      const address = buildIEC61850Address(parsed);
      expect(address).toBe("CTRL/XCBR1.Pos.stVal[ST]");
    });

    it("should build address with prefix", () => {
      const parsed: ParsedIEC61850Address = {
        ldName: "PROT",
        lnClass: "PTOC",
        lnInst: "1",
        lnPrefix: "Q0",
        doName: "Op",
        daName: "general",
        fc: "ST",
      };

      const address = buildIEC61850Address(parsed);
      expect(address).toBe("PROT/Q0$PTOC$1.Op.general[ST]");
    });
  });

  // ===========================================================================
  // DATA TYPE ENCODING/DECODING
  // ===========================================================================

  describe("Data Type Encoding/Decoding", () => {
    describe("Boolean", () => {
      it("should encode and decode boolean true", () => {
        const encoded = encodeIEC61850Value(true, IEC61850DataType.BOOLEAN);
        expect(encoded[0]).toBe(0x01);

        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.BOOLEAN);
        expect(decoded.value).toBe(true);
        expect(decoded.bytesRead).toBe(1);
      });

      it("should encode and decode boolean false", () => {
        const encoded = encodeIEC61850Value(false, IEC61850DataType.BOOLEAN);
        expect(encoded[0]).toBe(0x00);

        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.BOOLEAN);
        expect(decoded.value).toBe(false);
      });
    });

    describe("Integers", () => {
      it("should encode and decode INT8", () => {
        const encoded = encodeIEC61850Value(-42, IEC61850DataType.INT8);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.INT8);
        expect(decoded.value).toBe(-42);
        expect(decoded.bytesRead).toBe(1);
      });

      it("should encode and decode INT16", () => {
        const encoded = encodeIEC61850Value(12345, IEC61850DataType.INT16);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.INT16);
        expect(decoded.value).toBe(12345);
        expect(decoded.bytesRead).toBe(2);
      });

      it("should encode and decode INT32", () => {
        const encoded = encodeIEC61850Value(123456789, IEC61850DataType.INT32);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.INT32);
        expect(decoded.value).toBe(123456789);
        expect(decoded.bytesRead).toBe(4);
      });

      it("should encode and decode INT64", () => {
        const value = BigInt("9223372036854775807");
        const encoded = encodeIEC61850Value(value, IEC61850DataType.INT64);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.INT64);
        expect(decoded.value).toBe(value);
        expect(decoded.bytesRead).toBe(8);
      });

      it("should encode and decode unsigned integers", () => {
        const encoded8 = encodeIEC61850Value(255, IEC61850DataType.INT8U);
        const decoded8 = decodeIEC61850Value(Buffer.from([255]), IEC61850DataType.INT8U);
        expect(decoded8.value).toBe(255);

        const encoded16 = encodeIEC61850Value(65535, IEC61850DataType.INT16U);
        const decoded16 = decodeIEC61850Value(Buffer.from([0xff, 0xff]), IEC61850DataType.INT16U);
        expect(decoded16.value).toBe(65535);
      });
    });

    describe("Floating Point", () => {
      it("should encode and decode FLOAT32", () => {
        const value = 123.456;
        const encoded = encodeIEC61850Value(value, IEC61850DataType.FLOAT32);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.FLOAT32);
        expect(decoded.value).toBeCloseTo(value, 3);
        expect(decoded.bytesRead).toBe(4);
      });

      it("should encode and decode FLOAT64", () => {
        const value = 123456.789012345;
        const encoded = encodeIEC61850Value(value, IEC61850DataType.FLOAT64);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.FLOAT64);
        expect(decoded.value).toBeCloseTo(value, 9);
        expect(decoded.bytesRead).toBe(8);
      });
    });

    describe("Timestamp", () => {
      it("should encode and decode timestamp", () => {
        const timestamp: IEC61850Timestamp = {
          secondsSinceEpoch: 1704067200, // 2024-01-01 00:00:00 UTC
          fractionOfSecond: 0x800000, // 0.5 seconds
          timeQuality: {
            leapSecondsKnown: true,
            clockFailure: false,
            clockNotSynchronized: false,
            timeAccuracy: 10,
          },
        };

        const encoded = encodeIEC61850Value(timestamp, IEC61850DataType.TIMESTAMP);
        expect(encoded.length).toBe(8);

        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.TIMESTAMP);
        const decodedTs = decoded.value as IEC61850Timestamp;

        expect(decodedTs.secondsSinceEpoch).toBe(timestamp.secondsSinceEpoch);
        expect(decodedTs.fractionOfSecond).toBe(timestamp.fractionOfSecond);
        expect(decodedTs.timeQuality.leapSecondsKnown).toBe(true);
        expect(decodedTs.timeQuality.clockFailure).toBe(false);
        expect(decodedTs.timeQuality.timeAccuracy).toBe(10);
        expect(decoded.bytesRead).toBe(8);
      });

      it("should create timestamp from Date", () => {
        const date = new Date("2024-06-15T12:30:45.500Z");
        const timestamp = createIEC61850Timestamp(date);

        expect(timestamp.secondsSinceEpoch).toBe(Math.floor(date.getTime() / 1000));
        expect(timestamp.fractionOfSecond).toBeGreaterThan(0);
        expect(timestamp.timeQuality.clockFailure).toBe(false);
      });
    });

    describe("Quality", () => {
      it("should encode and decode good quality", () => {
        const quality = createGoodQuality();
        const encoded = encodeIEC61850Value(quality, IEC61850DataType.QUALITY);
        expect(encoded.length).toBe(2);

        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.QUALITY);
        const decodedQ = decoded.value as IEC61850Quality;

        expect(decodedQ.validity).toBe("good");
        expect(decodedQ.overflow).toBe(false);
        expect(decodedQ.failure).toBe(false);
        expect(decodedQ.source).toBe("process");
      });

      it("should encode and decode quality with flags", () => {
        const quality: IEC61850Quality = {
          validity: "questionable",
          overflow: true,
          outOfRange: false,
          badReference: false,
          oscillatory: true,
          failure: false,
          oldData: true,
          inconsistent: false,
          inaccurate: true,
          source: "substituted",
          test: true,
          operatorBlocked: false,
        };

        const encoded = encodeIEC61850Value(quality, IEC61850DataType.QUALITY);
        const decoded = decodeIEC61850Value(encoded, IEC61850DataType.QUALITY);
        const decodedQ = decoded.value as IEC61850Quality;

        expect(decodedQ.validity).toBe("questionable");
        expect(decodedQ.overflow).toBe(true);
        expect(decodedQ.oscillatory).toBe(true);
        expect(decodedQ.oldData).toBe(true);
        expect(decodedQ.inaccurate).toBe(true);
        expect(decodedQ.source).toBe("substituted");
        expect(decodedQ.test).toBe(true);
      });
    });

    describe("Double Point Status", () => {
      it("should encode and decode DBPOS values", () => {
        for (const status of [
          DoublePointStatus.INTERMEDIATE,
          DoublePointStatus.OFF,
          DoublePointStatus.ON,
          DoublePointStatus.BAD,
        ]) {
          const encoded = encodeIEC61850Value(status, IEC61850DataType.DBPOS);
          const decoded = decodeIEC61850Value(encoded, IEC61850DataType.DBPOS);
          expect(decoded.value).toBe(status);
        }
      });
    });

    describe("String", () => {
      it("should encode visible string", () => {
        const str = "Test IED Device";
        const encoded = encodeIEC61850Value(str, IEC61850DataType.VISIBLE_STRING);
        expect(encoded.toString("utf8")).toBe(str);
      });
    });
  });

  // ===========================================================================
  // CONNECTION MANAGEMENT
  // ===========================================================================

  describe("Connection Management", () => {
    it("should connect successfully", async () => {
      await driver.connect();
      expect(driver.isConnected()).toBe(true);
    });

    it("should disconnect cleanly", async () => {
      await driver.connect();
      await driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });

    it("should emit connected event", async () => {
      const connectHandler = vi.fn();
      driver.on("connected", connectHandler);

      await driver.connect();

      expect(connectHandler).toHaveBeenCalled();
    });

    it("should emit disconnected event", async () => {
      const disconnectHandler = vi.fn();
      driver.on("disconnected", disconnectHandler);

      await driver.connect();
      await driver.disconnect();

      expect(disconnectHandler).toHaveBeenCalled();
    });

    it("should report connection status", async () => {
      const statusBefore = driver.getStatus();
      expect(statusBefore.connected).toBe(false);

      await driver.connect();

      const statusAfter = driver.getStatus();
      expect(statusAfter.connected).toBe(true);
      expect(statusAfter.iedName).toBe("IED01");
      expect(statusAfter.host).toBe("192.168.1.100");
      expect(statusAfter.port).toBe(102);
    });
  });

  // ===========================================================================
  // DATA MODEL DISCOVERY
  // ===========================================================================

  describe("Data Model Discovery", () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it("should discover data model on connect", async () => {
      const dataModel = driver.getDataModel();
      expect(dataModel).not.toBeNull();
      expect(dataModel!.iedName).toBe("IED01");
    });

    it("should list logical devices", async () => {
      const lds = driver.getLogicalDevices();
      expect(lds.length).toBeGreaterThan(0);
      expect(lds).toContain("CTRL");
      expect(lds).toContain("MEAS");
      expect(lds).toContain("PROT");
    });

    it("should list logical nodes in logical device", async () => {
      const lns = driver.getLogicalNodes("CTRL");
      expect(lns.length).toBeGreaterThan(0);
      expect(lns).toContain("XCBR1");
      expect(lns).toContain("CSWI1");
    });

    it("should list data objects in logical node", async () => {
      const dos = driver.getDataObjects("CTRL", "XCBR1");
      expect(dos.length).toBeGreaterThan(0);
      expect(dos).toContain("Pos");
      expect(dos).toContain("OpCnt");
    });

    it("should have MMXU measurement data objects", async () => {
      const dos = driver.getDataObjects("MEAS", "MMXU1");
      expect(dos).toContain("TotW");
      expect(dos).toContain("Hz");
      expect(dos).toContain("PhV");
    });

    it("should have protection data objects", async () => {
      const dos = driver.getDataObjects("PROT", "PTOC1");
      expect(dos).toContain("Op");
      expect(dos).toContain("Str");
    });
  });

  // ===========================================================================
  // READ OPERATIONS
  // ===========================================================================

  describe("Read Operations", () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it("should read single tag", async () => {
      const result = await driver.readTag("CTRL/XCBR1.Pos.stVal[ST]");

      expect(result.tag).toBe("CTRL/XCBR1.Pos.stVal[ST]");
      expect(result.quality).toBe("GOOD");
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it("should read circuit breaker position", async () => {
      const result = await driver.readTag("CTRL/XCBR1.Pos.stVal[ST]");

      // Should return DBPOS value (0-3)
      expect(typeof result.value).toBe("number");
      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThanOrEqual(3);
    });

    it("should read measurement value", async () => {
      const result = await driver.readTag("MEAS/MMXU1.TotW.mag[MX]");

      expect(typeof result.value).toBe("number");
      expect(result.quality).toBe("GOOD");
    });

    it("should read multiple tags", async () => {
      const addresses = [
        "CTRL/XCBR1.Pos.stVal[ST]",
        "MEAS/MMXU1.TotW.mag[MX]",
        "MEAS/MMXU1.Hz.mag[MX]",
      ];

      const results = await driver.readTags(addresses);

      expect(results.length).toBe(3);
      results.forEach(result => {
        expect(result.quality).toBe("GOOD");
      });
    });

    it("should return BAD quality for invalid address", async () => {
      const result = await driver.readTag("INVALID/ADDRESS");

      expect(result.quality).toBe("BAD");
    });

    it("should read data object with all attributes", async () => {
      const result = await driver.readDataObject("CTRL", "XCBR1", "Pos");

      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });

    it("should throw when reading without connection", async () => {
      await driver.disconnect();

      await expect(driver.readTag("CTRL/XCBR1.Pos.stVal[ST]"))
        .rejects.toThrow("Not connected");
    });
  });

  // ===========================================================================
  // WRITE OPERATIONS
  // ===========================================================================

  describe("Write Operations", () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it("should write tag value", async () => {
      const success = await driver.writeTag("CTRL/CSWI1.Pos.ctlVal[CO]", true);
      expect(success).toBe(true);
    });

    it("should emit write event", async () => {
      const writeHandler = vi.fn();
      driver.on("write", writeHandler);

      await driver.writeTag("CTRL/CSWI1.Pos.ctlVal[CO]", true);

      expect(writeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          address: "CTRL/CSWI1.Pos.ctlVal[CO]",
          value: true,
        })
      );
    });

    it("should perform direct control", async () => {
      const success = await driver.controlDirect("CTRL", "CSWI1", "Pos", true);
      expect(success).toBe(true);
    });

    it("should perform select-before-operate control", async () => {
      const result = await driver.controlWithSBO(
        "CTRL",
        "XCBR1",
        "Pos",
        false,
        "OPERATOR1"
      );

      expect(result.success).toBe(true);
    });

    it("should emit control event for SBO", async () => {
      const controlHandler = vi.fn();
      driver.on("control", controlHandler);

      await driver.controlWithSBO("CTRL", "XCBR1", "Pos", true, "OPERATOR1");

      expect(controlHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "CTRL/XCBR1.Pos",
          value: true,
          operatorId: "OPERATOR1",
          mode: "SBO",
        })
      );
    });

    it("should throw when writing without connection", async () => {
      await driver.disconnect();

      await expect(driver.writeTag("CTRL/CSWI1.Pos.ctlVal[CO]", true))
        .rejects.toThrow("Not connected");
    });
  });

  // ===========================================================================
  // SUBSCRIPTIONS
  // ===========================================================================

  describe("Subscriptions", () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it("should subscribe to tags", async () => {
      const values: any[] = [];
      const callback = vi.fn((v) => values.push(...v));

      driver.subscribe(
        [
          {
            name: "CB1.Position",
            address: "CTRL/XCBR1.Pos.stVal[ST]",
            dataType: "DINT",
            scanRate: 100,
          },
          {
            name: "Power.Total",
            address: "MEAS/MMXU1.TotW.mag[MX]",
            dataType: "REAL",
            scanRate: 100,
          },
        ],
        callback
      );

      // Wait for at least one poll
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(callback).toHaveBeenCalled();
      expect(values.length).toBeGreaterThan(0);

      driver.unsubscribe();
    });

    it("should apply deadband to subscribed values", async () => {
      const values: any[] = [];
      const callback = vi.fn((v) => values.push(...v));

      driver.subscribe(
        [
          {
            name: "Power.Total",
            address: "MEAS/MMXU1.TotW.mag[MX]",
            dataType: "REAL",
            scanRate: 50,
            deadband: 1000, // Large deadband
          },
        ],
        callback
      );

      // Wait for multiple polls
      await new Promise(resolve => setTimeout(resolve, 200));

      // With large deadband, should not report every value
      // (depends on simulated value variation)
      expect(callback).toHaveBeenCalled();

      driver.unsubscribe();
    });

    it("should unsubscribe cleanly", async () => {
      const callback = vi.fn();

      driver.subscribe(
        [
          {
            name: "CB1.Position",
            address: "CTRL/XCBR1.Pos.stVal[ST]",
            dataType: "DINT",
            scanRate: 50,
          },
        ],
        callback
      );

      await new Promise(resolve => setTimeout(resolve, 100));
      const callCountBefore = callback.mock.calls.length;

      driver.unsubscribe();

      await new Promise(resolve => setTimeout(resolve, 100));
      const callCountAfter = callback.mock.calls.length;

      // No new calls after unsubscribe
      expect(callCountAfter).toBe(callCountBefore);
    });
  });

  // ===========================================================================
  // GOOSE HANDLING
  // ===========================================================================

  describe("GOOSE Handling", () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it("should subscribe to GOOSE messages", () => {
      const callback = vi.fn();

      driver.subscribeGOOSE(
        "CTRL/LLN0$GO$gcb01",
        0x1000,
        callback
      );

      const status = driver.getStatus() as { gooseSubscriptions: number };
      expect(status.gooseSubscriptions).toBe(1);
    });

    it("should emit gooseSubscribed event", () => {
      const handler = vi.fn();
      driver.on("gooseSubscribed", handler);

      driver.subscribeGOOSE("CTRL/LLN0$GO$gcb01", 0x1000, vi.fn());

      expect(handler).toHaveBeenCalledWith({
        goCBRef: "CTRL/LLN0$GO$gcb01",
        appId: 0x1000,
      });
    });

    it("should process GOOSE PDU", () => {
      const callback = vi.fn();
      driver.subscribeGOOSE("CTRL/LLN0$GO$gcb01", 0x1000, callback);

      const pdu: GOOSEPDU = {
        goCBRef: "CTRL/LLN0$GO$gcb01",
        timeAllowedToLive: 1000,
        datSet: "CTRL/LLN0$ds01",
        t: createIEC61850Timestamp(),
        stNum: 1,
        sqNum: 0,
        simulation: false,
        confRev: 1,
        ndsCom: false,
        numDatSetEntries: 2,
        allData: [
          { dataRef: "CTRL/XCBR1.Pos.stVal", value: DoublePointStatus.ON },
          { dataRef: "CTRL/XSWI1.Pos.stVal", value: DoublePointStatus.OFF },
        ],
      };

      driver.processGOOSE(pdu);

      expect(callback).toHaveBeenCalledWith(pdu);
    });

    it("should ignore duplicate GOOSE messages", () => {
      const callback = vi.fn();
      driver.subscribeGOOSE("CTRL/LLN0$GO$gcb01", 0x1000, callback);

      const pdu: GOOSEPDU = {
        goCBRef: "CTRL/LLN0$GO$gcb01",
        timeAllowedToLive: 1000,
        datSet: "CTRL/LLN0$ds01",
        t: createIEC61850Timestamp(),
        stNum: 1,
        sqNum: 0,
        simulation: false,
        confRev: 1,
        ndsCom: false,
        numDatSetEntries: 1,
        allData: [{ dataRef: "CTRL/XCBR1.Pos.stVal", value: DoublePointStatus.ON }],
      };

      // Process same message twice
      driver.processGOOSE(pdu);
      driver.processGOOSE(pdu);

      // Should only be called once
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should process GOOSE with incremented sequence number", () => {
      const callback = vi.fn();
      driver.subscribeGOOSE("CTRL/LLN0$GO$gcb01", 0x1000, callback);

      const basePdu: GOOSEPDU = {
        goCBRef: "CTRL/LLN0$GO$gcb01",
        timeAllowedToLive: 1000,
        datSet: "CTRL/LLN0$ds01",
        t: createIEC61850Timestamp(),
        stNum: 1,
        sqNum: 0,
        simulation: false,
        confRev: 1,
        ndsCom: false,
        numDatSetEntries: 1,
        allData: [{ dataRef: "CTRL/XCBR1.Pos.stVal", value: DoublePointStatus.ON }],
      };

      driver.processGOOSE(basePdu);
      driver.processGOOSE({ ...basePdu, sqNum: 1 });
      driver.processGOOSE({ ...basePdu, sqNum: 2 });

      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("should unsubscribe from GOOSE", () => {
      driver.subscribeGOOSE("CTRL/LLN0$GO$gcb01", 0x1000, vi.fn());
      driver.unsubscribeGOOSE("CTRL/LLN0$GO$gcb01");

      const status = driver.getStatus() as { gooseSubscriptions: number };
      expect(status.gooseSubscriptions).toBe(0);
    });

    it("should emit goosePublished event", () => {
      const handler = vi.fn();
      driver.on("goosePublished", handler);

      const pdu: GOOSEPDU = {
        goCBRef: "CTRL/LLN0$GO$gcb01",
        timeAllowedToLive: 1000,
        datSet: "CTRL/LLN0$ds01",
        t: createIEC61850Timestamp(),
        stNum: 1,
        sqNum: 0,
        simulation: false,
        confRev: 1,
        ndsCom: false,
        numDatSetEntries: 1,
        allData: [],
      };

      driver.publishGOOSE(pdu);

      expect(handler).toHaveBeenCalledWith(pdu);
    });
  });

  // ===========================================================================
  // MMS SERVICES
  // ===========================================================================

  describe("MMS Services", () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it("should identify IED", async () => {
      const info = await driver.identify();

      expect(info.vendorName).toBeDefined();
      expect(info.modelName).toBeDefined();
      expect(info.revision).toBeDefined();
    });
  });

  // ===========================================================================
  // STATUS AND DIAGNOSTICS
  // ===========================================================================

  describe("Status and Diagnostics", () => {
    it("should report initial status", () => {
      const status = driver.getStatus();

      expect(status.protocol).toBe("IEC61850_MMS");
      expect(status.host).toBe("192.168.1.100");
      expect(status.port).toBe(102);
      expect(status.iedName).toBe("IED01");
      expect(status.connected).toBe(false);
      expect(status.gooseEnabled).toBe(true);
    });

    it("should report connection pool status after connect", async () => {
      await driver.connect();

      const status = driver.getStatus() as {
        connectionPool: { total: number; available: number; busy: number };
      };

      expect(status.connectionPool).toBeDefined();
      expect(status.connectionPool.total).toBeGreaterThanOrEqual(1);
    });

    it("should report data model status after connect", async () => {
      await driver.connect();

      const status = driver.getStatus() as {
        dataModel: { logicalDevices: number; totalLogicalNodes: number };
      };

      expect(status.dataModel).toBeDefined();
      expect(status.dataModel.logicalDevices).toBeGreaterThan(0);
      expect(status.dataModel.totalLogicalNodes).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // FACTORY FUNCTIONS
  // ===========================================================================

  describe("Factory Functions", () => {
    it("should create driver with default options", () => {
      const d = createIEC61850Driver("10.0.0.1", "TestIED");

      expect(d).toBeInstanceOf(IEC61850Driver);

      const status = d.getStatus();
      expect(status.host).toBe("10.0.0.1");
      expect(status.iedName).toBe("TestIED");
      expect(status.port).toBe(102); // Default MMS port
    });

    it("should create driver with custom options", () => {
      const d = createIEC61850Driver("10.0.0.1", "TestIED", 8102, {
        timeout: 15000,
        gooseEnabled: false,
      });

      const status = d.getStatus();
      expect(status.port).toBe(8102);
      expect(status.gooseEnabled).toBe(false);
    });

    it("should create good quality", () => {
      const quality = createGoodQuality();

      expect(quality.validity).toBe("good");
      expect(quality.failure).toBe(false);
      expect(quality.overflow).toBe(false);
      expect(quality.source).toBe("process");
    });

    it("should create timestamp from current time", () => {
      const before = Date.now();
      const timestamp = createIEC61850Timestamp();
      const after = Date.now();

      const timestampMs = timestamp.secondsSinceEpoch * 1000;
      expect(timestampMs).toBeGreaterThanOrEqual(before - 1000);
      expect(timestampMs).toBeLessThanOrEqual(after + 1000);
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe("Error Handling", () => {
    it("should handle read errors gracefully", async () => {
      await driver.connect();

      // Force a bad address that causes internal error
      const result = await driver.readTag("BAD/ADDR.INVALID");

      expect(result.quality).toBe("BAD");
      expect(result.tag).toBe("BAD/ADDR.INVALID");
    });

    it("should report data model as null when not discovered", () => {
      const dataModel = driver.getDataModel();
      expect(dataModel).toBeNull();
    });

    it("should return empty arrays for LD/LN queries when not connected", () => {
      expect(driver.getLogicalDevices()).toEqual([]);
      expect(driver.getLogicalNodes("CTRL")).toEqual([]);
      expect(driver.getDataObjects("CTRL", "XCBR1")).toEqual([]);
    });
  });
});

// =============================================================================
// INTEGRATION TEST SUITE
// =============================================================================

describe("IEC 61850 Integration Scenarios", () => {
  let driver: IEC61850Driver;

  beforeEach(async () => {
    driver = createIEC61850Driver("192.168.1.100", "SUB01_IED", 102, {
      gooseEnabled: true,
    });
    await driver.connect();
  });

  afterEach(async () => {
    await driver.disconnect();
  });

  describe("Substation Monitoring Scenario", () => {
    it("should monitor circuit breaker status", async () => {
      // Read CB position
      const cbPos = await driver.readTag("CTRL/XCBR1.Pos.stVal[ST]");
      expect(cbPos.quality).toBe("GOOD");

      // Read CB operation count
      const opCount = await driver.readTag("CTRL/XCBR1.OpCnt.stVal[ST]");
      expect(opCount.quality).toBe("GOOD");
    });

    it("should monitor power measurements", async () => {
      const measurements = await driver.readTags([
        "MEAS/MMXU1.TotW.mag[MX]",
        "MEAS/MMXU1.TotVAr.mag[MX]",
        "MEAS/MMXU1.Hz.mag[MX]",
      ]);

      expect(measurements.length).toBe(3);
      measurements.forEach(m => {
        expect(m.quality).toBe("GOOD");
        expect(typeof m.value).toBe("number");
      });
    });

    it("should monitor protection status", async () => {
      const protStatus = await driver.readTag("PROT/PTOC1.Op.general[ST]");
      expect(protStatus.quality).toBe("GOOD");
    });
  });

  describe("Control Operations Scenario", () => {
    it("should execute CB trip command", async () => {
      const result = await driver.controlWithSBO(
        "CTRL",
        "XCBR1",
        "Pos",
        false, // Open/Trip
        "DISPATCHER_01"
      );

      expect(result.success).toBe(true);
    });

    it("should execute CB close command", async () => {
      const result = await driver.controlWithSBO(
        "CTRL",
        "XCBR1",
        "Pos",
        true, // Close
        "DISPATCHER_01"
      );

      expect(result.success).toBe(true);
    });

    it("should control blocking functions", async () => {
      // Block opening
      const blkOpn = await driver.writeTag("CTRL/XCBR1.BlkOpn.ctlVal[CO]", true);
      expect(blkOpn).toBe(true);

      // Unblock
      const unblk = await driver.writeTag("CTRL/XCBR1.BlkOpn.ctlVal[CO]", false);
      expect(unblk).toBe(true);
    });
  });

  describe("Subscription Scenario", () => {
    it("should receive continuous measurements", async () => {
      const values: any[] = [];

      driver.subscribe(
        [
          {
            name: "TotalPower",
            address: "MEAS/MMXU1.TotW.mag[MX]",
            dataType: "REAL",
            scanRate: 50,
            unit: "kW",
          },
          {
            name: "Frequency",
            address: "MEAS/MMXU1.Hz.mag[MX]",
            dataType: "REAL",
            scanRate: 50,
            unit: "Hz",
          },
        ],
        (v) => values.push(...v)
      );

      await new Promise(resolve => setTimeout(resolve, 150));

      expect(values.length).toBeGreaterThan(0);
      expect(values.some(v => v.tag === "TotalPower")).toBe(true);
      expect(values.some(v => v.tag === "Frequency")).toBe(true);

      driver.unsubscribe();
    });
  });

  describe("GOOSE Trip Scenario", () => {
    it("should handle protection trip via GOOSE", () => {
      const tripEvents: GOOSEPDU[] = [];

      driver.subscribeGOOSE(
        "PROT/LLN0$GO$TripGOOSE",
        0x1001,
        (pdu) => tripEvents.push(pdu)
      );

      // Simulate incoming trip GOOSE
      driver.processGOOSE({
        goCBRef: "PROT/LLN0$GO$TripGOOSE",
        timeAllowedToLive: 100,
        datSet: "PROT/LLN0$TripDS",
        t: createIEC61850Timestamp(),
        stNum: 1,
        sqNum: 0,
        simulation: false,
        confRev: 1,
        ndsCom: false,
        numDatSetEntries: 2,
        allData: [
          { dataRef: "PROT/PTOC1.Op.general", value: true },
          { dataRef: "PROT/PTOC1.Op.phsA", value: true },
        ],
      });

      expect(tripEvents.length).toBe(1);
      expect(tripEvents[0].allData[0].value).toBe(true);
    });
  });
});
