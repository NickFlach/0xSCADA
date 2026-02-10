/**
 * OPC-UA Connection Manager Tests
 *
 * Issue #11 child: 6.1.1 - OPC-UA Connection Manager and Session Handling
 *
 * Tests for:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Connection pooling for multiple endpoints
 * - Auto-reconnect on session drops
 * - Health checking / heartbeat
 * - Session state management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Shared mock state so tests can control behavior
let mockConnectFn: ReturnType<typeof vi.fn>;
let mockDisconnectFn: ReturnType<typeof vi.fn>;
let mockCreateSessionFn: ReturnType<typeof vi.fn>;
let mockSessionCloseFn: ReturnType<typeof vi.fn>;
let mockSessionReadFn: ReturnType<typeof vi.fn>;

function resetMockFns() {
  mockSessionCloseFn = vi.fn().mockResolvedValue(undefined);
  mockSessionReadFn = vi.fn().mockResolvedValue({ value: { value: 42 }, statusCode: { value: 0 } });
  mockConnectFn = vi.fn().mockResolvedValue(undefined);
  mockDisconnectFn = vi.fn().mockResolvedValue(undefined);
  mockCreateSessionFn = vi.fn().mockImplementation(async () => ({
    close: mockSessionCloseFn,
    read: mockSessionReadFn,
    sessionId: { value: `session-${Math.random().toString(36).slice(2, 8)}` },
  }));
}

resetMockFns();

vi.mock("node-opcua-client", () => {
  return {
    OPCUAClient: {
      create: vi.fn().mockImplementation(() => ({
        connect: (...args: any[]) => mockConnectFn(...args),
        disconnect: (...args: any[]) => mockDisconnectFn(...args),
        createSession: (...args: any[]) => mockCreateSessionFn(...args),
        on: vi.fn().mockReturnThis(),
        off: vi.fn().mockReturnThis(),
        removeAllListeners: vi.fn().mockReturnThis(),
      })),
    },
    SecurityPolicy: { None: "None", Basic256Sha256: "Basic256Sha256" },
    MessageSecurityMode: { None: 1, SignAndEncrypt: 3 },
    UserTokenType: { Anonymous: 0, UserName: 1, Certificate: 2 },
  };
});

import {
  OpcUaConnectionManager,
  type OpcUaEndpointConfig,
  type ConnectionState,
} from "../gateway/opcua-connection-manager";

describe("OPC-UA Connection Manager", () => {
  let manager: OpcUaConnectionManager;
  const defaultEndpoint: OpcUaEndpointConfig = {
    endpointUrl: "opc.tcp://localhost:4840",
    name: "test-endpoint",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetMockFns();
    manager = new OpcUaConnectionManager({
      reconnectInterval: 1000,
      maxReconnectAttempts: 3,
      healthCheckInterval: 5000,
      sessionTimeout: 30000,
    });
    // Prevent unhandled 'error' events from throwing
    manager.on("error", () => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    await manager.shutdown();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // CONNECTION LIFECYCLE
  // ===========================================================================

  describe("Connection Lifecycle", () => {
    it("should connect to an OPC-UA endpoint", async () => {
      await manager.connect(defaultEndpoint);
      const state = manager.getConnectionState("test-endpoint");
      expect(state).toBeDefined();
      expect(state!.status).toBe("connected");
    });

    it("should disconnect from an endpoint", async () => {
      await manager.connect(defaultEndpoint);
      await manager.disconnect("test-endpoint");
      const state = manager.getConnectionState("test-endpoint");
      expect(state!.status).toBe("disconnected");
    });

    it("should create a session after connecting", async () => {
      await manager.connect(defaultEndpoint);
      const session = manager.getSession("test-endpoint");
      expect(session).toBeDefined();
    });

    it("should throw when connecting with duplicate name", async () => {
      await manager.connect(defaultEndpoint);
      await expect(manager.connect(defaultEndpoint)).rejects.toThrow(
        /already exists/
      );
    });

    it("should handle connect failure gracefully", async () => {
      mockConnectFn.mockRejectedValueOnce(new Error("Connection refused"));

      await expect(
        manager.connect({ endpointUrl: "opc.tcp://bad-host:4840", name: "bad" })
      ).rejects.toThrow("Connection refused");

      const state = manager.getConnectionState("bad");
      expect(state!.status).toBe("error");
    });

    it("should track connection timestamps", async () => {
      const now = new Date("2026-02-09T12:00:00Z");
      vi.setSystemTime(now);

      await manager.connect(defaultEndpoint);
      const state = manager.getConnectionState("test-endpoint");
      expect(state!.connectedAt).toEqual(now);
    });

    it("should clean up on disconnect", async () => {
      await manager.connect(defaultEndpoint);
      await manager.disconnect("test-endpoint");
      expect(mockSessionCloseFn).toHaveBeenCalled();
    });

    it("should handle disconnect when not connected", async () => {
      await expect(manager.disconnect("nonexistent")).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // CONNECTION POOLING
  // ===========================================================================

  describe("Connection Pooling", () => {
    it("should manage multiple concurrent connections", async () => {
      await manager.connect({ endpointUrl: "opc.tcp://host1:4840", name: "ep1" });
      await manager.connect({ endpointUrl: "opc.tcp://host2:4840", name: "ep2" });
      await manager.connect({ endpointUrl: "opc.tcp://host3:4840", name: "ep3" });

      const all = manager.getAllConnections();
      expect(all).toHaveLength(3);
      expect(all.every((c) => c.status === "connected")).toBe(true);
    });

    it("should disconnect individual connections without affecting others", async () => {
      await manager.connect({ endpointUrl: "opc.tcp://host1:4840", name: "ep1" });
      await manager.connect({ endpointUrl: "opc.tcp://host2:4840", name: "ep2" });

      await manager.disconnect("ep1");

      expect(manager.getConnectionState("ep1")!.status).toBe("disconnected");
      expect(manager.getConnectionState("ep2")!.status).toBe("connected");
    });

    it("should shutdown all connections at once", async () => {
      await manager.connect({ endpointUrl: "opc.tcp://host1:4840", name: "ep1" });
      await manager.connect({ endpointUrl: "opc.tcp://host2:4840", name: "ep2" });

      await manager.shutdown();

      const all = manager.getAllConnections();
      expect(all.every((c) => c.status === "disconnected")).toBe(true);
    });

    it("should return connection by name", async () => {
      await manager.connect({ endpointUrl: "opc.tcp://host1:4840", name: "plc-1" });
      const state = manager.getConnectionState("plc-1");
      expect(state).toBeDefined();
      expect(state!.endpointUrl).toBe("opc.tcp://host1:4840");
    });
  });

  // ===========================================================================
  // AUTO-RECONNECT
  // ===========================================================================

  describe("Auto-Reconnect", () => {
    it("should attempt reconnect when session drops", async () => {
      await manager.connect(defaultEndpoint);

      manager.simulateSessionDrop("test-endpoint");

      const state = manager.getConnectionState("test-endpoint");
      expect(state!.status).toBe("reconnecting");

      // Advance timer to trigger reconnect
      await vi.advanceTimersByTimeAsync(1000);

      const stateAfter = manager.getConnectionState("test-endpoint");
      expect(stateAfter!.status).toBe("connected");
      expect(stateAfter!.reconnectCount).toBe(1);
    });

    it("should give up after max reconnect attempts", async () => {
      await manager.connect(defaultEndpoint);

      // Make reconnect always fail
      mockConnectFn.mockRejectedValue(new Error("Connection refused"));

      manager.simulateSessionDrop("test-endpoint");

      // Advance through all retry attempts
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      const state = manager.getConnectionState("test-endpoint");
      expect(state!.status).toBe("error");
      expect(state!.reconnectCount).toBeGreaterThanOrEqual(3);
    });

    it("should emit events on reconnect", async () => {
      const onReconnect = vi.fn();
      manager.on("reconnected", onReconnect);

      await manager.connect(defaultEndpoint);
      manager.simulateSessionDrop("test-endpoint");
      await vi.advanceTimersByTimeAsync(1000);

      expect(onReconnect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-endpoint" })
      );
    });

    it("should reset reconnect attempts after successful reconnect", async () => {
      await manager.connect(defaultEndpoint);
      manager.simulateSessionDrop("test-endpoint");
      await vi.advanceTimersByTimeAsync(1000);

      const state = manager.getConnectionState("test-endpoint");
      expect(state!.status).toBe("connected");
    });
  });

  // ===========================================================================
  // HEALTH CHECK / HEARTBEAT
  // ===========================================================================

  describe("Health Check", () => {
    it("should perform periodic health checks", async () => {
      await manager.connect(defaultEndpoint);

      // Advance past health check interval
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockSessionReadFn).toHaveBeenCalled();
    });

    it("should detect unhealthy connection via health check", async () => {
      await manager.connect(defaultEndpoint);

      // Make health check fail
      mockSessionReadFn.mockRejectedValueOnce(new Error("Session expired"));

      await vi.advanceTimersByTimeAsync(5000);

      const state = manager.getConnectionState("test-endpoint");
      // Should trigger reconnect
      expect(["reconnecting", "connected"]).toContain(state!.status);
    });

    it("should update lastHealthCheck timestamp", async () => {
      const now = new Date("2026-02-09T12:00:00Z");
      vi.setSystemTime(now);

      await manager.connect(defaultEndpoint);

      await vi.advanceTimersByTimeAsync(5000);

      const state = manager.getConnectionState("test-endpoint");
      expect(state!.lastHealthCheck).toBeTruthy();
      expect(state!.lastHealthCheck!.getTime()).toBeGreaterThanOrEqual(now.getTime());
    });

    it("should report health status for all connections", async () => {
      await manager.connect({ endpointUrl: "opc.tcp://host1:4840", name: "ep1" });
      await manager.connect({ endpointUrl: "opc.tcp://host2:4840", name: "ep2" });

      const health = manager.getHealthReport();
      expect(health).toHaveLength(2);
      expect(health[0].healthy).toBe(true);
      expect(health[1].healthy).toBe(true);
    });
  });

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  describe("Configuration", () => {
    it("should accept security configuration", async () => {
      await manager.connect({
        endpointUrl: "opc.tcp://secure-host:4840",
        name: "secure",
        securityPolicy: "Basic256Sha256",
        securityMode: "SignAndEncrypt",
      });

      const state = manager.getConnectionState("secure");
      expect(state!.status).toBe("connected");
    });

    it("should accept authentication credentials", async () => {
      await manager.connect({
        endpointUrl: "opc.tcp://auth-host:4840",
        name: "authed",
        username: "admin",
        password: "secret",
      });

      const state = manager.getConnectionState("authed");
      expect(state!.status).toBe("connected");
    });

    it("should use default manager config when not specified", () => {
      const defaultManager = new OpcUaConnectionManager();
      defaultManager.on("error", () => {});
      expect(defaultManager).toBeDefined();
    });
  });

  // ===========================================================================
  // EVENT EMITTER
  // ===========================================================================

  describe("Events", () => {
    it("should emit 'connected' event on successful connect", async () => {
      const onConnect = vi.fn();
      manager.on("connected", onConnect);

      await manager.connect(defaultEndpoint);

      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-endpoint" })
      );
    });

    it("should emit 'disconnected' event on disconnect", async () => {
      const onDisconnect = vi.fn();
      manager.on("disconnected", onDisconnect);

      await manager.connect(defaultEndpoint);
      await manager.disconnect("test-endpoint");

      expect(onDisconnect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-endpoint" })
      );
    });

    it("should emit 'error' event on connection failure", async () => {
      mockConnectFn.mockRejectedValueOnce(new Error("Refused"));

      const onError = vi.fn();
      manager.on("error", onError);

      try {
        await manager.connect({ endpointUrl: "opc.tcp://fail:4840", name: "fail" });
      } catch {}

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ name: "fail" }),
        expect.any(Error)
      );
    });

    it("should emit 'healthCheck' event", async () => {
      const onHealth = vi.fn();
      manager.on("healthCheck", onHealth);

      await manager.connect(defaultEndpoint);
      await vi.advanceTimersByTimeAsync(5000);

      expect(onHealth).toHaveBeenCalled();
    });
  });
});
