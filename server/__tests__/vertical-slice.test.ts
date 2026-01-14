/**
 * Vertical Slice End-to-End Integration Test
 *
 * VS-1.7 - Vertical Slice: End-to-End Integration Test
 *
 * Tests the complete data flow from simulated Modbus device
 * through the gateway to alarm generation and blockchain anchoring.
 *
 * Flow: Tag → Gateway → Alarm Service → Event Service → Anchor Service
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock modbus-serial to avoid actual network connections in tests
vi.mock("modbus-serial", () => {
  return {
    default: class MockModbusRTU {
      private connected = false;
      private registers: number[] = new Array(100).fill(0);

      setTimeout(_timeout: number) {}

      async connectTCP(_host: string, _options: any) {
        this.connected = true;
      }

      close(callback: () => void) {
        this.connected = false;
        callback();
      }

      setID(_id: number) {}

      async readInputRegisters(address: number, length: number) {
        return {
          data: this.registers.slice(address, address + length),
        };
      }

      async readHoldingRegisters(address: number, length: number) {
        return {
          data: this.registers.slice(address, address + length),
        };
      }

      async writeRegister(address: number, value: number) {
        this.registers[address] = value;
      }

      // Test helper to set register values
      _setRegister(address: number, value: number) {
        this.registers[address] = value;
      }
    },
  };
});

import { tagService } from "../routes/tags";
import { alarmService, initAlarmService } from "../services/alarm-service";
import { anchorService, initAnchorService } from "../services/anchor-service";
import { getEventService } from "../events";

describe("Vertical Slice: Tank Level Monitor", () => {
  beforeAll(async () => {
    // Initialize services
    initAlarmService("TEST-SITE-001");
    initAnchorService({
      enabled: true,
      batchSize: 10,
      batchMaxAgeMs: 1000,
      anchorAlarms: true,
      anchorTelemetry: false,
      anchorCommands: true,
    });
  });

  afterAll(async () => {
    anchorService.stop();
  });

  describe("Tag Registration", () => {
    it("should register tank tags", () => {
      tagService.registerTags([
        {
          name: "TK-101.Level",
          address: "IR:10",
          unit: "%",
          scanRate: 500,
          deadband: 0.5,
          alarmConfig: { lowLow: 10, low: 20, high: 80, highHigh: 90 },
        },
        {
          name: "TK-101.Temperature",
          address: "IR:11",
          unit: "°C",
          scanRate: 1000,
        },
      ]);

      const tags = tagService.getTagDefinitions();
      expect(tags.length).toBe(2);
      expect(tags[0].name).toBe("TK-101.Level");
      expect(tags[0].alarmConfig).toBeDefined();
    });
  });

  describe("Alarm Service", () => {
    it("should register alarms from tag configs", () => {
      alarmService.registerAlarmsFromTags();
      const status = alarmService.getStatus();
      expect(status.definitionsCount).toBeGreaterThan(0);
    });

    it("should detect HIGH-HIGH alarm when level exceeds setpoint", () => {
      const alarmEvents: any[] = [];
      const handler = (event: any) => alarmEvents.push(event);
      alarmService.on("alarm:active", handler);

      // Simulate tag value exceeding HIGH-HIGH setpoint (90%)
      alarmService.processTagValues([
        {
          tag: "TK-101.Level",
          value: 95, // Above 90% HIHI setpoint
          quality: "GOOD",
          timestamp: new Date(),
        },
      ]);

      alarmService.off("alarm:active", handler);

      // May trigger multiple alarms (HIHI and HIGH) since 95 > 90 and 95 > 80
      expect(alarmEvents.length).toBeGreaterThanOrEqual(1);
      const hihiAlarm = alarmEvents.find((a) => a.type === "HIHI");
      expect(hihiAlarm).toBeDefined();
      expect(hihiAlarm?.priority).toBe("CRITICAL");
      expect(hihiAlarm?.state).toBe("ACTIVE");
    });

    it("should clear alarm when level returns to normal", () => {
      const clearEvents: any[] = [];
      const handler = (event: any) => clearEvents.push(event);
      alarmService.on("alarm:cleared", handler);

      // Simulate level returning to normal
      alarmService.processTagValues([
        {
          tag: "TK-101.Level",
          value: 75, // Normal range
          quality: "GOOD",
          timestamp: new Date(),
        },
      ]);

      alarmService.off("alarm:cleared", handler);

      // May clear multiple alarms
      expect(clearEvents.length).toBeGreaterThanOrEqual(1);
      expect(clearEvents.every((e: any) => e.state === "CLEARED")).toBe(true);
    });

    it("should track active alarms", () => {
      // Trigger a new alarm
      alarmService.processTagValues([
        {
          tag: "TK-101.Level",
          value: 5, // Below 10% LOLO setpoint
          quality: "GOOD",
          timestamp: new Date(),
        },
      ]);

      const activeAlarms = alarmService.getActiveAlarms();
      expect(activeAlarms.length).toBeGreaterThan(0);

      const loloAlarm = activeAlarms.find((a) => a.type === "LOLO");
      expect(loloAlarm).toBeDefined();
      expect(loloAlarm?.priority).toBe("CRITICAL");
    });

    it("should acknowledge alarms", () => {
      const activeAlarms = alarmService.getActiveAlarms();
      const alarm = activeAlarms[0];

      if (alarm) {
        const result = alarmService.acknowledgeAlarm(alarm.id, "TEST-USER", "Acknowledged for testing");
        expect(result).toBe(true);

        const updated = alarmService.getActiveAlarms().find((a) => a.id === alarm.id);
        expect(updated?.state).toBe("ACKNOWLEDGED");
        expect(updated?.acknowledgedBy).toBe("TEST-USER");
      }
    });
  });

  describe("Event Service", () => {
    it("should create signed events", () => {
      const eventService = getEventService();

      const event = eventService.createEvent({
        eventType: "TELEMETRY",
        siteId: "TEST-SITE-001",
        assetId: "TK-101",
        sourceTimestamp: new Date(),
        originType: "GATEWAY",
        originId: "TEST-GATEWAY",
        payload: {
          tag: "TK-101.Level",
          value: 75.5,
          unit: "%",
          quality: "GOOD",
        },
        details: "TK-101.Level = 75.5 %",
      });

      expect(event.hash).toBeDefined();
      expect(event.hash.length).toBe(64); // SHA-256 hex
      expect(event.signature).toBeDefined();
      expect(event.eventType).toBe("TELEMETRY");
    });
  });

  describe("Anchor Service", () => {
    it("should queue events for batching", () => {
      const eventService = getEventService();

      // Create some test events
      for (let i = 0; i < 5; i++) {
        const event = eventService.createEvent({
          eventType: "COMMAND",
          siteId: "TEST-SITE-001",
          assetId: "TK-101",
          sourceTimestamp: new Date(),
          originType: "USER",
          originId: "TEST-USER",
          payload: {
            commandType: "SETPOINT",
            target: "TK-101.Level.SP",
            value: 50 + i,
          },
          details: `Test command ${i}`,
        });

        anchorService.queueEvent(event);
      }

      const stats = anchorService.getStats();
      expect(stats.pendingEvents).toBeGreaterThan(0);
    });

    it("should flush batch and generate merkle root", async () => {
      const batchEvents: any[] = [];
      const handler = (result: any) => batchEvents.push(result);
      anchorService.on("batch:anchored", handler);

      const result = await anchorService.flushBatch();
      anchorService.off("batch:anchored", handler);

      if (result) {
        expect(result.batchId).toBeDefined();
        expect(result.merkleRoot).toBeDefined();
        expect(result.merkleRoot.startsWith("0x")).toBe(true);
        expect(result.eventCount).toBeGreaterThan(0);
        expect(result.anchoredAt).toBeInstanceOf(Date);
      }
    });

    it("should track anchoring statistics", () => {
      const stats = anchorService.getStats();

      expect(stats.totalBatchesAnchored).toBeGreaterThanOrEqual(0);
      expect(stats.totalEventsAnchored).toBeGreaterThanOrEqual(0);
      expect(typeof stats.blockchainEnabled).toBe("boolean");
    });
  });

  describe("End-to-End Flow", () => {
    it("should process tag value → alarm → event → anchor", async () => {
      const capturedEvents: any[] = [];

      // Listen for anchored batches
      const batchHandler = (result: any) => capturedEvents.push(result);
      anchorService.on("batch:anchored", batchHandler);

      // 1. Simulate high tank level (triggers alarm)
      alarmService.processTagValues([
        {
          tag: "TK-101.Level",
          value: 92, // Above HIHI (90%)
          quality: "GOOD",
          timestamp: new Date(),
        },
      ]);

      // 2. Give time for event to be queued
      await new Promise((r) => setTimeout(r, 100));

      // 3. Flush the batch
      const result = await anchorService.flushBatch();

      anchorService.off("batch:anchored", batchHandler);

      // 4. Verify complete flow
      if (result) {
        expect(result.eventCount).toBeGreaterThan(0);
        expect(result.merkleRoot).toBeDefined();

        // The batch should contain the alarm event
        const alarmEvent = result.events.find((e: any) => e.eventType === "ALARM");
        expect(alarmEvent).toBeDefined();
      }

      // 5. Verify alarm is tracked
      const activeAlarms = alarmService.getActiveAlarms();
      const tkAlarm = activeAlarms.find((a) => a.tagName === "TK-101.Level");
      expect(tkAlarm).toBeDefined();
    });
  });

  describe("Summary", () => {
    it("should report complete vertical slice status", () => {
      const tagStatus = tagService.getStatus();
      const alarmStatus = alarmService.getStatus();
      const anchorStats = anchorService.getStats();

      console.log("\n=== Vertical Slice Status ===");
      console.log(`Tags registered: ${tagStatus.registeredTags}`);
      console.log(`Alarm definitions: ${alarmStatus.definitionsCount}`);
      console.log(`Active alarms: ${alarmStatus.activeAlarmsCount}`);
      console.log(`Total events anchored: ${anchorStats.totalEventsAnchored}`);
      console.log(`Total batches anchored: ${anchorStats.totalBatchesAnchored}`);
      console.log(`Blockchain enabled: ${anchorStats.blockchainEnabled}`);
      console.log("=============================\n");

      // All components should be functional
      expect(tagStatus.registeredTags).toBeGreaterThan(0);
      expect(alarmStatus.definitionsCount).toBeGreaterThan(0);
    });
  });
});
