/**
 * FluxCommander Tests
 * See ADR-0015 §4 "Command Property Protocol"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FluxCommander } from "../flux-commander";
import type { FluxConfig, FluxCommand, FluxCommandAck } from "../types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConfig(overrides: Partial<FluxConfig> = {}): FluxConfig {
  return {
    url: "http://localhost:3000",
    publishIntervalMs: 10000,
    entityPrefix: "scada/",
    stream: "scada",
    source: "test-instance",
    enabled: true,
    ...overrides,
  };
}

describe("FluxCommander", () => {
  let commander: FluxCommander;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    commander?.stop();
    vi.useRealTimers();
  });

  it("should register command handlers", () => {
    commander = new FluxCommander(makeConfig());
    const handler = vi.fn();
    commander.registerHandler("set_speed", handler);
    // No error = success
  });

  it("should detect new commands by cmd_id", async () => {
    commander = new FluxCommander(makeConfig());
    const handler = vi.fn().mockResolvedValue({
      cmd_ack: "cmd-001",
      cmd_status: "completed" as const,
    });
    commander.registerHandler("set_speed", handler);
    commander.watchEntity("pump-01");

    // First poll — returns a command
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          entity_id: "scada/pump-01/control",
          properties: { command: "set_speed", cmd_id: "cmd-001", target_rpm: 1200 },
        }),
      })
      .mockResolvedValueOnce({ ok: true }); // ack POST

    commander.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("pump-01", expect.objectContaining({
      command: "set_speed",
      cmd_id: "cmd-001",
      target_rpm: 1200,
    }));
  });

  it("should not re-process the same cmd_id", async () => {
    commander = new FluxCommander(makeConfig());
    const handler = vi.fn().mockResolvedValue({ cmd_ack: "cmd-001", cmd_status: "completed" as const });
    commander.registerHandler("set_speed", handler);
    commander.watchEntity("pump-01");

    const controlEntity = {
      ok: true,
      status: 200,
      json: async () => ({
        entity_id: "scada/pump-01/control",
        properties: { command: "set_speed", cmd_id: "cmd-001" },
      }),
    };

    mockFetch
      .mockResolvedValueOnce(controlEntity)
      .mockResolvedValueOnce({ ok: true }) // ack
      .mockResolvedValueOnce(controlEntity); // second poll, same cmd_id

    commander.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("should reject unknown commands", async () => {
    commander = new FluxCommander(makeConfig());
    commander.watchEntity("pump-01");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          entity_id: "scada/pump-01/control",
          properties: { command: "unknown_cmd", cmd_id: "cmd-002" },
        }),
      })
      .mockResolvedValueOnce({ ok: true }); // ack

    commander.start();
    await vi.advanceTimersByTimeAsync(5000);

    // Should have published a rejection ack
    const ackCall = mockFetch.mock.calls.find(
      ([url, opts]) => opts?.method === "POST"
    );
    expect(ackCall).toBeDefined();
    const body = JSON.parse(ackCall![1].body);
    expect(body.payload.properties.cmd_status).toBe("rejected");
  });

  it("should handle 404 (no control entity) gracefully", async () => {
    commander = new FluxCommander(makeConfig());
    commander.watchEntity("pump-01");

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    commander.start();
    await vi.advanceTimersByTimeAsync(5000);

    // No crash, no ack posted
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should publish failure ack when handler throws", async () => {
    commander = new FluxCommander(makeConfig());
    commander.registerHandler("set_speed", async () => {
      throw new Error("Motor fault");
    });
    commander.watchEntity("pump-01");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          entity_id: "scada/pump-01/control",
          properties: { command: "set_speed", cmd_id: "cmd-003" },
        }),
      })
      .mockResolvedValueOnce({ ok: true }); // ack

    commander.start();
    await vi.advanceTimersByTimeAsync(5000);

    const ackCall = mockFetch.mock.calls.find(
      ([url, opts]) => opts?.method === "POST"
    );
    const body = JSON.parse(ackCall![1].body);
    expect(body.payload.properties.cmd_status).toBe("failed");
    expect(body.payload.properties.error).toContain("Motor fault");
  });
});
