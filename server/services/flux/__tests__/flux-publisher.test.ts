/**
 * FluxPublisher Tests
 * See ADR-0015 for design rationale
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FluxPublisher } from "../flux-publisher";
import type { FluxConfig } from "../types";

// Mock fetch globally
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

describe("FluxPublisher", () => {
  let publisher: FluxPublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    publisher?.stop();
  });

  describe("publishEntity", () => {
    it("should queue events with correct entity ID prefix", () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });

      const status = publisher.getStatus();
      expect(status.pendingEvents).toBe(1);
    });

    it("should not queue events when disabled", () => {
      publisher = new FluxPublisher(makeConfig({ enabled: false }));
      publisher.publishEntity("pump-01", { status: "running" });

      expect(publisher.getStatus().pendingEvents).toBe(0);
    });

    it("should throttle rapid updates to the same entity", () => {
      publisher = new FluxPublisher(makeConfig({ publishIntervalMs: 10000 }));
      publisher.publishEntity("pump-01", { status: "running" });
      publisher.publishEntity("pump-01", { status: "stopped" }); // should be throttled

      expect(publisher.getStatus().pendingEvents).toBe(1);
    });

    it("should allow updates to different entities", () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });
      publisher.publishEntity("pump-02", { status: "stopped" });

      expect(publisher.getStatus().pendingEvents).toBe(2);
    });
  });

  describe("convenience methods", () => {
    it("publishSite should prefix with site/", async () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishSite("plant-north", { status: "ONLINE" });
      await publisher.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/events",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"scada/site/plant-north"'),
        })
      );
    });

    it("publishAsset should use direct prefix", async () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishAsset("pump-01", { flow_rate: 45.2 });
      await publisher.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/events",
        expect.objectContaining({
          body: expect.stringContaining('"scada/pump-01"'),
        })
      );
    });

    it("publishAlert should prefix with alert/", async () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishAlert("high-temp-01", { severity: "CRITICAL" });
      await publisher.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/events",
        expect.objectContaining({
          body: expect.stringContaining('"scada/alert/high-temp-01"'),
        })
      );
    });
  });

  describe("flush", () => {
    it("should POST single event directly", async () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });
      await publisher.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/events");
      
      const body = JSON.parse(opts.body);
      expect(body.stream).toBe("scada");
      expect(body.source).toBe("test-instance");
      expect(body.payload.entity_id).toBe("scada/pump-01");
      expect(body.payload.properties.status).toBe("running");
      expect(typeof body.timestamp).toBe("number");
    });

    it("should batch multiple events", async () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });
      publisher.publishEntity("pump-02", { status: "stopped" });
      await publisher.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:3000/api/events/batch");
    });

    it("should do nothing when queue is empty", async () => {
      publisher = new FluxPublisher(makeConfig());
      await publisher.flush();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should re-queue events on failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });
      await publisher.flush();

      expect(publisher.getStatus().pendingEvents).toBe(1);
      expect(publisher.getStatus().consecutiveFailures).toBe(1);
    });

    it("should reset failure count on success after failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("fail"));
      
      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });
      await publisher.flush(); // fails
      expect(publisher.getStatus().consecutiveFailures).toBe(1);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await publisher.flush(); // succeeds
      expect(publisher.getStatus().consecutiveFailures).toBe(0);
    });
  });

  describe("getEntity", () => {
    it("should fetch entity by ID", async () => {
      const entity = { entity_id: "scada/pump-01", properties: { status: "running" } };
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => entity });

      publisher = new FluxPublisher(makeConfig());
      const result = await publisher.getEntity("pump-01");

      expect(result).toEqual(entity);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/state/entities/scada%2Fpump-01",
        expect.any(Object)
      );
    });

    it("should return null for 404", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      publisher = new FluxPublisher(makeConfig());
      const result = await publisher.getEntity("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("auth", () => {
    it("should include Authorization header when token configured", async () => {
      publisher = new FluxPublisher(makeConfig({ authToken: "my-token" }));
      publisher.publishEntity("pump-01", { status: "running" });
      await publisher.flush();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer my-token");
    });

    it("should not include Authorization header without token", async () => {
      publisher = new FluxPublisher(makeConfig());
      publisher.publishEntity("pump-01", { status: "running" });
      await publisher.flush();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe("getStatus", () => {
    it("should return current state", () => {
      publisher = new FluxPublisher(makeConfig());
      const status = publisher.getStatus();

      expect(status).toEqual({
        enabled: true,
        url: "http://localhost:3000",
        pendingEvents: 0,
        consecutiveFailures: 0,
      });
    });
  });
});
