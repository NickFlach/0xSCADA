/**
 * OPC-UA Read/Write Value Service Tests
 *
 * Issue #11 child: 6.1.3 - OPC-UA Read/Write Value Service
 *
 * TDD tests for reading and writing OPC-UA variable values
 * with data type validation, batch operations, timestamps,
 * and status code handling.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  OpcUaReadWriteService,
  type OpcUaSession,
  type ReadValueResult,
  type WriteValueResult,
  type OpcUaDataType,
  type OpcUaStatusCode,
  type ReadRequest,
  type WriteRequest,
  mapStatusCode,
  validateDataType,
} from "../gateway/opcua-read-write-service";

// =============================================================================
// MOCK SESSION FACTORY
// =============================================================================

function createMockSession(overrides: Partial<OpcUaSession> = {}): OpcUaSession {
  return {
    read: vi.fn().mockResolvedValue([
      {
        statusCode: { value: 0, name: "Good" },
        value: { value: 42.5, dataType: "Double" },
        sourceTimestamp: new Date("2026-01-15T10:00:00Z"),
        serverTimestamp: new Date("2026-01-15T10:00:01Z"),
      },
    ]),
    write: vi.fn().mockResolvedValue([
      { value: 0, name: "Good" },
    ]),
    ...overrides,
  };
}

// =============================================================================
// READ VALUE TESTS
// =============================================================================

describe("OpcUaReadWriteService", () => {
  let service: OpcUaReadWriteService;
  let mockSession: OpcUaSession;

  beforeEach(() => {
    mockSession = createMockSession();
    service = new OpcUaReadWriteService(mockSession);
  });

  // ===========================================================================
  // READ SINGLE VALUE
  // ===========================================================================

  describe("readValue", () => {
    it("should read a single value by nodeId", async () => {
      const result = await service.readValue("ns=2;s=Temperature");

      expect(result).toBeDefined();
      expect(result.value).toBe(42.5);
      expect(result.statusCode.value).toBe(0);
      expect(result.dataType).toBe("Double");
      expect(mockSession.read).toHaveBeenCalledTimes(1);
    });

    it("should include source and server timestamps", async () => {
      const result = await service.readValue("ns=2;s=Temperature");

      expect(result.sourceTimestamp).toBeInstanceOf(Date);
      expect(result.serverTimestamp).toBeInstanceOf(Date);
      expect(result.sourceTimestamp!.toISOString()).toBe("2026-01-15T10:00:00.000Z");
      expect(result.serverTimestamp!.toISOString()).toBe("2026-01-15T10:00:01.000Z");
    });

    it("should handle bad status codes", async () => {
      mockSession.read = vi.fn().mockResolvedValue([
        {
          statusCode: { value: 0x80000000, name: "Bad" },
          value: { value: null, dataType: "Null" },
          sourceTimestamp: null,
          serverTimestamp: new Date(),
        },
      ]);

      const result = await service.readValue("ns=2;s=InvalidNode");

      expect(result.statusCode.value).toBe(0x80000000);
      expect(result.quality).toBe("BAD");
    });

    it("should handle uncertain status codes", async () => {
      mockSession.read = vi.fn().mockResolvedValue([
        {
          statusCode: { value: 0x40000000, name: "Uncertain" },
          value: { value: 10, dataType: "Int32" },
          sourceTimestamp: new Date(),
          serverTimestamp: new Date(),
        },
      ]);

      const result = await service.readValue("ns=2;s=SensorStale");

      expect(result.quality).toBe("UNCERTAIN");
    });

    it("should map good status to GOOD quality", async () => {
      const result = await service.readValue("ns=2;s=Temperature");
      expect(result.quality).toBe("GOOD");
    });

    it("should throw on session error", async () => {
      mockSession.read = vi.fn().mockRejectedValue(new Error("Session closed"));

      await expect(service.readValue("ns=2;s=Temp")).rejects.toThrow("Session closed");
    });
  });

  // ===========================================================================
  // READ MULTIPLE VALUES
  // ===========================================================================

  describe("readValues", () => {
    it("should read multiple values in a single call", async () => {
      mockSession.read = vi.fn().mockResolvedValue([
        {
          statusCode: { value: 0, name: "Good" },
          value: { value: 42.5, dataType: "Double" },
          sourceTimestamp: new Date(),
          serverTimestamp: new Date(),
        },
        {
          statusCode: { value: 0, name: "Good" },
          value: { value: 100, dataType: "Int32" },
          sourceTimestamp: new Date(),
          serverTimestamp: new Date(),
        },
      ]);

      const results = await service.readValues([
        "ns=2;s=Temperature",
        "ns=2;s=Pressure",
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].value).toBe(42.5);
      expect(results[1].value).toBe(100);
      // Should be a single batch call
      expect(mockSession.read).toHaveBeenCalledTimes(1);
    });

    it("should handle partial failures in batch read", async () => {
      mockSession.read = vi.fn().mockResolvedValue([
        {
          statusCode: { value: 0, name: "Good" },
          value: { value: 42.5, dataType: "Double" },
          sourceTimestamp: new Date(),
          serverTimestamp: new Date(),
        },
        {
          statusCode: { value: 0x80000000, name: "BadNodeIdUnknown" },
          value: { value: null, dataType: "Null" },
          sourceTimestamp: null,
          serverTimestamp: new Date(),
        },
      ]);

      const results = await service.readValues([
        "ns=2;s=Temperature",
        "ns=2;s=NonExistent",
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].quality).toBe("GOOD");
      expect(results[1].quality).toBe("BAD");
    });

    it("should return empty array for empty input", async () => {
      const results = await service.readValues([]);
      expect(results).toEqual([]);
      expect(mockSession.read).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // READ WITH OPTIONS
  // ===========================================================================

  describe("readValue with options", () => {
    it("should support ReadRequest with maxAge", async () => {
      const request: ReadRequest = {
        nodeId: "ns=2;s=Temperature",
        maxAge: 5000,
      };

      const result = await service.readValueWithOptions(request);
      expect(result.value).toBe(42.5);
      expect(mockSession.read).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ maxAge: 5000 }),
        ])
      );
    });
  });

  // ===========================================================================
  // WRITE SINGLE VALUE
  // ===========================================================================

  describe("writeValue", () => {
    it("should write a single value", async () => {
      const result = await service.writeValue("ns=2;s=Setpoint", 75.0, "Double");

      expect(result.success).toBe(true);
      expect(result.statusCode.value).toBe(0);
      expect(mockSession.write).toHaveBeenCalledTimes(1);
    });

    it("should return failure on bad status", async () => {
      mockSession.write = vi.fn().mockResolvedValue([
        { value: 0x80000000, name: "BadNotWritable" },
      ]);

      const result = await service.writeValue("ns=2;s=ReadOnly", 10, "Int32");

      expect(result.success).toBe(false);
      expect(result.statusCode.value).toBe(0x80000000);
    });

    it("should throw on session error during write", async () => {
      mockSession.write = vi.fn().mockRejectedValue(new Error("Timeout"));

      await expect(
        service.writeValue("ns=2;s=Setpoint", 50, "Double")
      ).rejects.toThrow("Timeout");
    });
  });

  // ===========================================================================
  // WRITE MULTIPLE VALUES
  // ===========================================================================

  describe("writeValues", () => {
    it("should write multiple values in a single call", async () => {
      mockSession.write = vi.fn().mockResolvedValue([
        { value: 0, name: "Good" },
        { value: 0, name: "Good" },
      ]);

      const requests: WriteRequest[] = [
        { nodeId: "ns=2;s=Setpoint1", value: 50, dataType: "Double" },
        { nodeId: "ns=2;s=Setpoint2", value: true, dataType: "Boolean" },
      ];

      const results = await service.writeValues(requests);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(mockSession.write).toHaveBeenCalledTimes(1);
    });

    it("should handle partial write failures", async () => {
      mockSession.write = vi.fn().mockResolvedValue([
        { value: 0, name: "Good" },
        { value: 0x80000000, name: "BadTypeMismatch" },
      ]);

      const requests: WriteRequest[] = [
        { nodeId: "ns=2;s=Setpoint1", value: 50, dataType: "Double" },
        { nodeId: "ns=2;s=Setpoint2", value: true, dataType: "Boolean" },
      ];

      const results = await service.writeValues(requests);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it("should return empty array for empty input", async () => {
      const results = await service.writeValues([]);
      expect(results).toEqual([]);
      expect(mockSession.write).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // DATA TYPE VALIDATION
  // ===========================================================================

  describe("validateDataType", () => {
    it("should validate Boolean values", () => {
      expect(validateDataType(true, "Boolean")).toBe(true);
      expect(validateDataType(false, "Boolean")).toBe(true);
      expect(validateDataType(42, "Boolean")).toBe(false);
      expect(validateDataType("true", "Boolean")).toBe(false);
    });

    it("should validate integer types", () => {
      expect(validateDataType(42, "Int16")).toBe(true);
      expect(validateDataType(42, "Int32")).toBe(true);
      expect(validateDataType(42, "UInt16")).toBe(true);
      expect(validateDataType(42, "UInt32")).toBe(true);
      expect(validateDataType(42.5, "Int32")).toBe(false);
      expect(validateDataType("42", "Int32")).toBe(false);
    });

    it("should validate unsigned integers reject negative values", () => {
      expect(validateDataType(-1, "UInt16")).toBe(false);
      expect(validateDataType(-1, "UInt32")).toBe(false);
      expect(validateDataType(0, "UInt16")).toBe(true);
    });

    it("should validate Float and Double", () => {
      expect(validateDataType(42.5, "Float")).toBe(true);
      expect(validateDataType(42, "Float")).toBe(true);
      expect(validateDataType(42.5, "Double")).toBe(true);
      expect(validateDataType("42.5", "Double")).toBe(false);
    });

    it("should validate String", () => {
      expect(validateDataType("hello", "String")).toBe(true);
      expect(validateDataType(42, "String")).toBe(false);
    });

    it("should validate Byte", () => {
      expect(validateDataType(0, "Byte")).toBe(true);
      expect(validateDataType(255, "Byte")).toBe(true);
      expect(validateDataType(256, "Byte")).toBe(false);
      expect(validateDataType(-1, "Byte")).toBe(false);
    });
  });

  // ===========================================================================
  // WRITE WITH VALIDATION
  // ===========================================================================

  describe("writeValue with validation", () => {
    it("should reject write with invalid data type", async () => {
      await expect(
        service.writeValue("ns=2;s=BoolTag", 42, "Boolean")
      ).rejects.toThrow("Data type validation failed");
    });

    it("should reject negative value for unsigned type", async () => {
      await expect(
        service.writeValue("ns=2;s=Counter", -1, "UInt32")
      ).rejects.toThrow("Data type validation failed");
    });

    it("should accept valid typed write", async () => {
      const result = await service.writeValue("ns=2;s=Setpoint", 42.5, "Double");
      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // STATUS CODE MAPPING
  // ===========================================================================

  describe("mapStatusCode", () => {
    it("should map 0 to GOOD", () => {
      expect(mapStatusCode(0)).toBe("GOOD");
    });

    it("should map 0x4xxxxxxx to UNCERTAIN", () => {
      expect(mapStatusCode(0x40000000)).toBe("UNCERTAIN");
      expect(mapStatusCode(0x40800000)).toBe("UNCERTAIN");
    });

    it("should map 0x8xxxxxxx to BAD", () => {
      expect(mapStatusCode(0x80000000)).toBe("BAD");
      expect(mapStatusCode(0x80010000)).toBe("BAD");
    });

    it("should map other good range values to GOOD", () => {
      expect(mapStatusCode(0x00000001)).toBe("GOOD");
      expect(mapStatusCode(0x0A000000)).toBe("GOOD");
    });
  });

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  describe("batch operations", () => {
    it("should split large read batches", async () => {
      // Create 150 node IDs (batch size default 100)
      const nodeIds = Array.from({ length: 150 }, (_, i) => `ns=2;s=Tag${i}`);

      mockSession.read = vi.fn()
        .mockResolvedValueOnce(
          Array.from({ length: 100 }, () => ({
            statusCode: { value: 0, name: "Good" },
            value: { value: 1, dataType: "Double" },
            sourceTimestamp: new Date(),
            serverTimestamp: new Date(),
          }))
        )
        .mockResolvedValueOnce(
          Array.from({ length: 50 }, () => ({
            statusCode: { value: 0, name: "Good" },
            value: { value: 2, dataType: "Double" },
            sourceTimestamp: new Date(),
            serverTimestamp: new Date(),
          }))
        );

      const results = await service.readValues(nodeIds, { batchSize: 100 });

      expect(results).toHaveLength(150);
      expect(mockSession.read).toHaveBeenCalledTimes(2);
      // First batch returns value 1, second returns value 2
      expect(results[0].value).toBe(1);
      expect(results[100].value).toBe(2);
    });

    it("should split large write batches", async () => {
      const requests: WriteRequest[] = Array.from({ length: 120 }, (_, i) => ({
        nodeId: `ns=2;s=Tag${i}`,
        value: i,
        dataType: "Double" as OpcUaDataType,
      }));

      mockSession.write = vi.fn()
        .mockResolvedValueOnce(
          Array.from({ length: 100 }, () => ({ value: 0, name: "Good" }))
        )
        .mockResolvedValueOnce(
          Array.from({ length: 20 }, () => ({ value: 0, name: "Good" }))
        );

      const results = await service.writeValues(requests, { batchSize: 100 });

      expect(results).toHaveLength(120);
      expect(mockSession.write).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe("error handling", () => {
    it("should wrap session errors with context", async () => {
      mockSession.read = vi.fn().mockRejectedValue(new Error("Connection lost"));

      try {
        await service.readValue("ns=2;s=Temp");
        expect.unreachable("Should have thrown");
      } catch (e: any) {
        expect(e.message).toContain("Connection lost");
      }
    });

    it("should handle null values in read results gracefully", async () => {
      mockSession.read = vi.fn().mockResolvedValue([
        {
          statusCode: { value: 0, name: "Good" },
          value: { value: null, dataType: "Null" },
          sourceTimestamp: null,
          serverTimestamp: null,
        },
      ]);

      const result = await service.readValue("ns=2;s=NullTag");
      expect(result.value).toBeNull();
      expect(result.sourceTimestamp).toBeNull();
    });
  });
});
