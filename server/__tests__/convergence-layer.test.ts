/**
 * Tests for ADR-0011: OT/IT Convergence Standards
 * 
 * Covers:
 * - Agent domain registration and access control
 * - Domain boundary enforcement (IT→OT blocked)
 * - Data translation with audit logging
 * - Outage buffering and flush on reconnect
 * - Health status reporting
 * - Failure isolation rules
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConvergenceLayer } from "../agents/convergence-layer";
import {
  AgentDomainType,
  Domain,
  TranslationType,
  AGENT_DOMAIN_ACCESS,
  FAILURE_ISOLATION_RULES,
} from "@shared/types/convergence-layer";

describe("ConvergenceLayer", () => {
  let layer: ConvergenceLayer;

  beforeEach(() => {
    layer = new ConvergenceLayer();
    // Start with all connections up
    layer.setOtGatewayStatus(true);
    layer.setItServicesStatus(true);
    layer.setGovernanceStatus(true);
  });

  describe("agent domain registration", () => {
    it("should register an agent with domain type", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);
      expect(layer.getAgentDomainType("ops-agent")).toBe("CONVERGENCE");
    });

    it("should return undefined for unregistered agent", () => {
      expect(layer.getAgentDomainType("unknown")).toBeUndefined();
    });

    it("should unregister an agent", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);
      layer.unregisterAgent("ops-agent");
      expect(layer.getAgentDomainType("ops-agent")).toBeUndefined();
    });
  });

  describe("domain boundary enforcement", () => {
    it("should BLOCK IT_ONLY agent from accessing OT domain", () => {
      layer.registerAgent("dashboard-agent", AgentDomainType.IT_ONLY);

      const result = layer.checkDomainAccess("dashboard-agent", Domain.OT, "read");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("NO OT access");
    });

    it("should BLOCK IT_ONLY agent from writing to OT", () => {
      layer.registerAgent("dashboard-agent", AgentDomainType.IT_ONLY);

      const result = layer.checkDomainAccess("dashboard-agent", Domain.OT, "write");
      expect(result.allowed).toBe(false);
    });

    it("should ALLOW CONVERGENCE agent to read from OT via gateway", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);

      const result = layer.checkDomainAccess("ops-agent", Domain.OT, "read");
      expect(result.allowed).toBe(true);
    });

    it("should BLOCK CONVERGENCE agent from writing to OT", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);

      const result = layer.checkDomainAccess("ops-agent", Domain.OT, "write");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("only READ");
    });

    it("should ALLOW OT_SUPERVISED agent bounded write to OT", () => {
      layer.registerAgent("change-control", AgentDomainType.OT_SUPERVISED);

      const result = layer.checkDomainAccess("change-control", Domain.OT, "write");
      expect(result.allowed).toBe(true);
    });

    it("should BLOCK OT_NATIVE agent from IT access", () => {
      layer.registerAgent("plc-logic", AgentDomainType.OT_NATIVE);

      const result = layer.checkDomainAccess("plc-logic", Domain.IT, "read");
      expect(result.allowed).toBe(false);
    });

    it("should ALLOW OT_NATIVE agent to publish to convergence", () => {
      layer.registerAgent("plc-logic", AgentDomainType.OT_NATIVE);

      const writeResult = layer.checkDomainAccess("plc-logic", Domain.CONVERGENCE, "write");
      expect(writeResult.allowed).toBe(true);
    });

    it("should BLOCK OT_NATIVE agent from reading convergence", () => {
      layer.registerAgent("plc-logic", AgentDomainType.OT_NATIVE);

      const readResult = layer.checkDomainAccess("plc-logic", Domain.CONVERGENCE, "read");
      expect(readResult.allowed).toBe(false);
      expect(readResult.reason).toContain("publish_only");
    });

    it("should deny access for unregistered agents", () => {
      const result = layer.checkDomainAccess("unknown", Domain.IT, "read");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not registered");
    });
  });

  describe("data translation", () => {
    it("should translate with full audit trail", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);

      const result = layer.translate({
        agentId: "ops-agent",
        translationType: "TAG_TO_EVENT" as TranslationType,
        sourceDomain: Domain.OT,
        targetDomain: Domain.IT,
        inputData: { tag: "TT-101", value: 72.5, unit: "degF" },
        protocol: "OPCUA" as any,
      });

      expect(result.success).toBe(true);
      expect(result.outputHash).toBeDefined();
      expect(result.auditEntry).toBeDefined();
      expect(result.auditEntry!.boundaryCheck).toBe("PASS");
      expect(result.auditEntry!.inputHash).toBeTruthy();
      expect(result.auditEntry!.outputHash).toBeTruthy();
    });

    it("should block translation that violates domain access", () => {
      layer.registerAgent("dashboard", AgentDomainType.IT_ONLY);

      const result = layer.translate({
        agentId: "dashboard",
        translationType: "COMMAND_TO_SETPOINT" as TranslationType,
        sourceDomain: Domain.IT,
        targetDomain: Domain.OT,
        inputData: { command: "set_temp", value: 80 },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("NO OT access");
    });

    it("should include audit entry in log", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);

      layer.translate({
        agentId: "ops-agent",
        translationType: "TAG_TO_EVENT" as TranslationType,
        sourceDomain: Domain.OT,
        targetDomain: Domain.IT,
        inputData: { tag: "PT-201", value: 14.7 },
      });

      const log = layer.getAuditLog({ agentId: "ops-agent" });
      expect(log.length).toBe(1);
      expect(log[0].agentId).toBe("ops-agent");
      expect(log[0].translationType).toBe("TAG_TO_EVENT");
    });
  });

  describe("outage buffering", () => {
    it("should buffer translations when OT gateway is down", () => {
      layer.registerAgent("ops-agent", AgentDomainType.OT_SUPERVISED);
      layer.setOtGatewayStatus(false);

      const result = layer.translate({
        agentId: "ops-agent",
        translationType: "COMMAND_TO_SETPOINT" as TranslationType,
        sourceDomain: Domain.IT,
        targetDomain: Domain.OT,
        inputData: { command: "adjust", value: 5 },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("buffered");

      const stats = layer.getStats();
      expect(stats.bufferedTranslations).toBe(1);
    });

    it("should buffer translations when IT services are down", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);
      layer.setItServicesStatus(false);

      const result = layer.translate({
        agentId: "ops-agent",
        translationType: "TAG_TO_EVENT" as TranslationType,
        sourceDomain: Domain.OT,
        targetDomain: Domain.IT,
        inputData: { tag: "FT-301", value: 150 },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("buffered");
    });

    it("should flush buffer when connection is restored", () => {
      layer.registerAgent("ops-agent", AgentDomainType.CONVERGENCE);
      layer.setItServicesStatus(false);

      // Buffer some translations
      layer.translate({
        agentId: "ops-agent",
        translationType: "TAG_TO_EVENT" as TranslationType,
        sourceDomain: Domain.OT,
        targetDomain: Domain.IT,
        inputData: { tag: "LT-401", value: 85 },
      });
      layer.translate({
        agentId: "ops-agent",
        translationType: "ALARM_TO_ALERT" as TranslationType,
        sourceDomain: Domain.OT,
        targetDomain: Domain.IT,
        inputData: { alarm: "HIGH_LEVEL", priority: 2 },
      });

      expect(layer.getStats().bufferedTranslations).toBe(2);

      // Restore connection — should flush
      layer.setItServicesStatus(true);

      expect(layer.getStats().bufferedTranslations).toBe(0);

      // Flushed entries should appear in audit log
      const log = layer.getAuditLog({ agentId: "ops-agent" });
      expect(log.length).toBe(2);
    });
  });

  describe("health status", () => {
    it("should report HEALTHY when all connected", () => {
      const health = layer.getHealth();
      expect(health.status).toBe("HEALTHY");
      expect(health.otGateway.connected).toBe(true);
      expect(health.itServices.connected).toBe(true);
      expect(health.governance.connected).toBe(true);
    });

    it("should report OT_DISCONNECTED when OT gateway is down", () => {
      layer.setOtGatewayStatus(false);
      expect(layer.getHealth().status).toBe("OT_DISCONNECTED");
    });

    it("should report IT_DISCONNECTED when IT services are down", () => {
      layer.setItServicesStatus(false);
      expect(layer.getHealth().status).toBe("IT_DISCONNECTED");
    });

    it("should report OFFLINE when both are down", () => {
      layer.setOtGatewayStatus(false);
      layer.setItServicesStatus(false);
      expect(layer.getHealth().status).toBe("OFFLINE");
    });

    it("should include time sync info", () => {
      const health = layer.getHealth();
      expect(health.timeSync.ntpAvailable).toBe(true);
      expect(health.timeSync.ptpAvailable).toBe(true); // OT connected
    });

    it("should report PTP unavailable when OT is disconnected", () => {
      layer.setOtGatewayStatus(false);
      const health = layer.getHealth();
      expect(health.timeSync.ptpAvailable).toBe(false);
    });
  });

  describe("failure isolation rules", () => {
    it("should document that IT failure has no OT impact", () => {
      expect(FAILURE_ISOLATION_RULES.IT_FAILURE.otImpact).toContain("NONE");
      expect(FAILURE_ISOLATION_RULES.IT_FAILURE.critical).toContain("No IT failure can propagate");
    });

    it("should document that OT gateway failure has no OT impact", () => {
      expect(FAILURE_ISOLATION_RULES.OT_GATEWAY_FAILURE.otImpact).toContain("NONE");
    });

    it("should document governance failure graceful degradation", () => {
      expect(FAILURE_ISOLATION_RULES.GOVERNANCE_FAILURE.agentImpact).toContain("existing tokens continue");
    });
  });

  describe("statistics", () => {
    it("should report agent registration stats", () => {
      layer.registerAgent("a1", AgentDomainType.IT_ONLY);
      layer.registerAgent("a2", AgentDomainType.CONVERGENCE);
      layer.registerAgent("a3", AgentDomainType.CONVERGENCE);
      layer.registerAgent("a4", AgentDomainType.OT_SUPERVISED);

      const stats = layer.getStats();
      expect(stats.registeredAgents).toBe(4);
      expect(stats.byDomainType["IT_ONLY"]).toBe(1);
      expect(stats.byDomainType["CONVERGENCE"]).toBe(2);
      expect(stats.byDomainType["OT_SUPERVISED"]).toBe(1);
    });
  });

  describe("domain access constants", () => {
    it("should define access for all domain types", () => {
      for (const domainType of Object.values(AgentDomainType)) {
        expect(AGENT_DOMAIN_ACCESS[domainType]).toBeDefined();
        expect(AGENT_DOMAIN_ACCESS[domainType].description).toBeTruthy();
        expect(AGENT_DOMAIN_ACCESS[domainType].examples.length).toBeGreaterThan(0);
      }
    });

    it("should ensure IT_ONLY has no OT access", () => {
      expect(AGENT_DOMAIN_ACCESS.IT_ONLY.otAccess).toBe("none");
    });

    it("should ensure OT_NATIVE has no IT access", () => {
      expect(AGENT_DOMAIN_ACCESS.OT_NATIVE.itAccess).toBe("none");
    });
  });
});
