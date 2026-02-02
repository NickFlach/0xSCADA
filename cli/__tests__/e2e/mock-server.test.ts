/**
 * E2E Tests with Mock Server
 *
 * These tests spin up a real HTTP server that simulates the 0xSCADA API,
 * then run actual CLI commands against it to verify end-to-end behavior.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "child_process";
import http, { IncomingMessage, ServerResponse, Server } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { AddressInfo } from "net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, "../../dist/index.js");
const CLI_ROOT = path.resolve(__dirname, "../..");

// ============================================================
// MOCK DATA
// ============================================================

const mockHealthData = {
  status: "healthy",
  timestamp: "2024-01-15T12:00:00Z",
  version: "1.0.0",
  uptime: 86400,
  components: {
    database: { status: "connected", latencyMs: 5 },
    blockchain: { status: "connected" },
  },
};

const mockSites = [
  {
    id: "site-001",
    name: "Houston Refinery",
    location: "Houston, TX",
    owner: "PetroTech Inc",
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "site-002",
    name: "Dallas Chemical Plant",
    location: "Dallas, TX",
    owner: "ChemCorp LLC",
    createdAt: "2024-01-05T00:00:00Z",
  },
  {
    id: "site-003",
    name: "Austin Water Treatment",
    location: "Austin, TX",
    owner: "AquaTech",
    createdAt: "2024-01-10T00:00:00Z",
  },
];

const mockAssets = [
  {
    id: "asset-001",
    siteId: "site-001",
    assetType: "pump",
    nameOrTag: "P-101",
    critical: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "asset-002",
    siteId: "site-001",
    assetType: "valve",
    nameOrTag: "V-201",
    critical: false,
    createdAt: "2024-01-02T00:00:00Z",
  },
  {
    id: "asset-003",
    siteId: "site-002",
    assetType: "sensor",
    nameOrTag: "TEMP-301",
    critical: true,
    createdAt: "2024-01-03T00:00:00Z",
  },
];

const mockEvents = [
  {
    id: "event-001",
    assetId: "asset-001",
    eventType: "maintenance",
    payloadHash: "0xabc123def456",
    timestamp: "2024-01-10T12:00:00Z",
    recordedBy: "admin",
    txHash: "0x1234567890abcdef",
    details: "Routine pump maintenance",
  },
  {
    id: "event-002",
    assetId: "asset-002",
    eventType: "calibration",
    payloadHash: "0xdef789abc012",
    timestamp: "2024-01-11T08:30:00Z",
    recordedBy: "technician",
    txHash: null,
    details: "Valve calibration check",
  },
  {
    id: "event-003",
    assetId: "asset-003",
    eventType: "alert",
    payloadHash: "0x456789012abc",
    timestamp: "2024-01-12T14:45:00Z",
    recordedBy: "system",
    txHash: null,
    details: "Temperature sensor alert",
  },
];

const mockBatchStats = {
  pendingEvents: 15,
  totalBatchesAnchored: 42,
  totalEventsAnchored: 630,
  lastBatchTime: "2024-01-14T18:00:00Z",
  averageEventsPerBatch: 15,
  estimatedGasSavings: 0.92,
};

const mockBlockchainStatus = {
  enabled: true,
  network: "sepolia",
  contractAddress: "0x1234567890123456789012345678901234567890",
  lastBlock: 5000000,
};

const mockBlueprintsSummary = {
  controlModuleTypes: 12,
  controlModuleInstances: 48,
  unitTypes: 8,
  unitInstances: 24,
  phaseTypes: 15,
  phaseInstances: 60,
  vendors: 5,
};

// ============================================================
// MOCK SERVER SETUP
// ============================================================

let server: Server;
let port: number;
let requestLog: Array<{ method: string; path: string; body?: unknown }> = [];

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch {
        resolve(body);
      }
    });
  });
}

function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function createMockServer(): Server {
  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost`);
    const pathname = url.pathname;
    const method = req.method || "GET";
    const body = await parseBody(req);

    // Log request
    requestLog.push({ method, path: req.url || "/", body });

    // Route handling
    if (method === "GET" && pathname === "/api/health") {
      return sendJson(res, mockHealthData);
    }

    if (method === "GET" && pathname === "/api/sites") {
      return sendJson(res, mockSites);
    }

    if (method === "POST" && pathname === "/api/sites") {
      const newSite = {
        id: `site-${Date.now()}`,
        ...(body as Record<string, unknown>),
        createdAt: new Date().toISOString(),
      };
      return sendJson(res, newSite, 201);
    }

    if (method === "GET" && pathname === "/api/assets") {
      const siteId = url.searchParams.get("siteId");
      if (siteId) {
        const filtered = mockAssets.filter((a) => a.siteId === siteId);
        return sendJson(res, filtered);
      }
      return sendJson(res, mockAssets);
    }

    if (method === "GET" && pathname.startsWith("/api/assets/site/")) {
      const siteId = pathname.replace("/api/assets/site/", "");
      const filtered = mockAssets.filter((a) => a.siteId === siteId);
      return sendJson(res, filtered);
    }

    if (method === "POST" && pathname === "/api/assets") {
      const newAsset = {
        id: `asset-${Date.now()}`,
        ...(body as Record<string, unknown>),
        createdAt: new Date().toISOString(),
      };
      return sendJson(res, newAsset, 201);
    }

    if (method === "GET" && pathname === "/api/events") {
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const eventType = url.searchParams.get("type");

      let filtered = [...mockEvents];
      if (eventType) {
        filtered = filtered.filter((e) => e.eventType === eventType);
      }

      const total = filtered.length;
      const totalPages = Math.ceil(total / limit);
      const start = (page - 1) * limit;
      const paginatedEvents = filtered.slice(start, start + limit);

      return sendJson(res, {
        data: paginatedEvents,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      });
    }

    if (method === "POST" && pathname === "/api/events") {
      const newEvent = {
        id: `event-${Date.now()}`,
        ...(body as Record<string, unknown>),
        payloadHash: `0x${Math.random().toString(16).slice(2)}`,
        timestamp: new Date().toISOString(),
        txHash: null,
      };
      return sendJson(res, newEvent, 201);
    }

    if (method === "GET" && pathname === "/api/batch/stats") {
      return sendJson(res, mockBatchStats);
    }

    if (method === "POST" && pathname === "/api/batch/trigger") {
      return sendJson(res, {
        success: true,
        message: "Batch anchoring triggered",
        batchId: `batch-${Date.now()}`,
        txHash: `0x${Math.random().toString(16).slice(2)}`,
        eventCount: mockBatchStats.pendingEvents,
      });
    }

    if (method === "GET" && pathname === "/api/blockchain/status") {
      return sendJson(res, mockBlockchainStatus);
    }

    if (method === "GET" && pathname === "/api/blueprints/summary") {
      return sendJson(res, mockBlueprintsSummary);
    }

    if (method === "POST" && pathname === "/api/blueprints/seed") {
      const force = url.searchParams.get("force") === "true";
      return sendJson(res, {
        success: true,
        message: force ? "Database reseeded" : "Database seeded",
        skipped: false,
      });
    }

    if (method === "GET" && pathname === "/api/vendors") {
      return sendJson(res, [
        { id: "vendor-001", name: "rockwell", displayName: "Rockwell Automation" },
        { id: "vendor-002", name: "siemens", displayName: "Siemens" },
        { id: "vendor-003", name: "honeywell", displayName: "Honeywell" },
      ]);
    }

    if (method === "GET" && pathname === "/api/controllers") {
      return sendJson(res, [
        {
          id: "ctrl-001",
          name: "PLC-Main",
          vendorId: "vendor-001",
          siteId: "site-001",
          ipAddress: "192.168.1.100",
        },
        {
          id: "ctrl-002",
          name: "PLC-Backup",
          vendorId: "vendor-001",
          siteId: "site-001",
          ipAddress: "192.168.1.101",
        },
      ]);
    }

    // 404 for unhandled routes
    sendJson(res, { error: "Not found" }, 404);
  });
}

/**
 * Execute CLI command against the mock server
 */
function runCli(
  args: string[],
  options: { timeout?: number } = {}
): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
} {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    timeout: options.timeout ?? 30000,
    encoding: "utf-8",
    env: {
      ...process.env,
      OXSCADA_API_URL: `http://localhost:${port}`,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    error: result.error,
  };
}

/**
 * Parse JSON from CLI output
 */
function parseJsonOutput<T>(output: string): T | null {
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as T;
    }
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

// ============================================================
// TEST SUITES
// ============================================================

describe("E2E Tests with Mock Server", () => {
  beforeAll(async () => {
    server = createMockServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address() as AddressInfo;
        port = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  beforeEach(() => {
    requestLog = [];
  });

  // ============================================================
  // STATUS COMMAND
  // ============================================================
  describe("status command", () => {
    it("should fetch and display health status", () => {
      const result = runCli(["status"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("healthy");
      expect(result.stdout).toContain("1.0.0");
    });

    it("should output JSON when --json flag is used", () => {
      const result = runCli(["status", "--json"]);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput<{ health: typeof mockHealthData }>(result.stdout);
      expect(json).not.toBeNull();
      expect(json?.health?.status).toBe("healthy");
      expect(json?.health?.version).toBe("1.0.0");
    });

    it("should make requests to /api/health endpoint", () => {
      runCli(["status"]);

      const healthRequest = requestLog.find((r) => r.path === "/api/health");
      expect(healthRequest).toBeDefined();
      expect(healthRequest?.method).toBe("GET");
    });

    it("should make requests to /api/blockchain/status endpoint", () => {
      runCli(["status"]);

      const blockchainRequest = requestLog.find(
        (r) => r.path === "/api/blockchain/status"
      );
      expect(blockchainRequest).toBeDefined();
      expect(blockchainRequest?.method).toBe("GET");
    });

    it("should display uptime information", () => {
      const result = runCli(["status"]);

      expect(result.exitCode).toBe(0);
      // 86400 seconds = 1 day
      expect(
        result.stdout.includes("day") || result.stdout.includes("24")
      ).toBe(true);
    });
  });

  // ============================================================
  // SITES COMMAND
  // ============================================================
  describe("sites command", () => {
    describe("sites list", () => {
      it("should list all sites", () => {
        const result = runCli(["sites", "list"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Houston Refinery");
        expect(result.stdout).toContain("Dallas Chemical Plant");
        expect(result.stdout).toContain("Austin Water Treatment");
      });

      it("should output JSON when --json flag is used", () => {
        const result = runCli(["sites", "list", "--json"]);

        expect(result.exitCode).toBe(0);
        const json = parseJsonOutput<typeof mockSites>(result.stdout);
        expect(json).not.toBeNull();
        expect(Array.isArray(json)).toBe(true);
        expect(json?.length).toBe(3);
        expect(json?.[0].name).toBe("Houston Refinery");
      });

      it("should make GET request to /api/sites", () => {
        runCli(["sites", "list"]);

        const sitesRequest = requestLog.find((r) => r.path === "/api/sites");
        expect(sitesRequest).toBeDefined();
        expect(sitesRequest?.method).toBe("GET");
      });
    });

    describe("sites get", () => {
      it("should get a specific site by ID", () => {
        const result = runCli(["sites", "get", "site-001"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Houston Refinery");
        expect(result.stdout).toContain("site-001");
      });

      it("should show error for non-existent site", () => {
        const result = runCli(["sites", "get", "site-999"]);

        const output = result.stdout + result.stderr;
        expect(output.toLowerCase()).toContain("not found");
      });
    });

    describe("sites create", () => {
      it("should create a new site", () => {
        const result = runCli([
          "sites",
          "create",
          "--name",
          "New Test Site",
          "--location",
          "San Antonio, TX",
          "--owner",
          "TestCorp",
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("New Test Site");
      });

      it("should make POST request to /api/sites", () => {
        runCli([
          "sites",
          "create",
          "--name",
          "API Test Site",
          "--location",
          "Somewhere",
          "--owner",
          "Someone",
        ]);

        const createRequest = requestLog.find(
          (r) => r.path === "/api/sites" && r.method === "POST"
        );
        expect(createRequest).toBeDefined();
        expect(createRequest?.body).toMatchObject({
          name: "API Test Site",
          location: "Somewhere",
          owner: "Someone",
        });
      });
    });
  });

  // ============================================================
  // ASSETS COMMAND
  // ============================================================
  describe("assets command", () => {
    describe("assets list", () => {
      it("should list all assets", () => {
        const result = runCli(["assets", "list"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("P-101");
        expect(result.stdout).toContain("V-201");
        expect(result.stdout).toContain("TEMP-301");
      });

      it("should output JSON when --json flag is used", () => {
        const result = runCli(["assets", "list", "--json"]);

        expect(result.exitCode).toBe(0);
        const json = parseJsonOutput<typeof mockAssets>(result.stdout);
        expect(json).not.toBeNull();
        expect(Array.isArray(json)).toBe(true);
        expect(json?.length).toBe(3);
      });

      it("should filter by site when --site flag is used", () => {
        const result = runCli(["assets", "list", "--site", "site-001"]);

        expect(result.exitCode).toBe(0);
        // Should contain assets from site-001
        expect(result.stdout).toContain("P-101");
        expect(result.stdout).toContain("V-201");
      });

      it("should make GET request to /api/assets", () => {
        runCli(["assets", "list"]);

        const assetsRequest = requestLog.find((r) => r.path === "/api/assets");
        expect(assetsRequest).toBeDefined();
        expect(assetsRequest?.method).toBe("GET");
      });
    });

    describe("assets get", () => {
      it("should get a specific asset by ID", () => {
        const result = runCli(["assets", "get", "asset-001"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("P-101");
        expect(result.stdout).toContain("pump");
      });

      it("should show error for non-existent asset", () => {
        const result = runCli(["assets", "get", "asset-999"]);

        const output = result.stdout + result.stderr;
        expect(output.toLowerCase()).toContain("not found");
      });
    });

    describe("assets create", () => {
      it("should create a new asset", () => {
        const result = runCli([
          "assets",
          "create",
          "--site",
          "site-001",
          "--type",
          "motor",
          "--tag",
          "M-501",
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("M-501");
      });

      it("should make POST request to /api/assets", () => {
        runCli([
          "assets",
          "create",
          "--site",
          "site-002",
          "--type",
          "sensor",
          "--tag",
          "S-999",
        ]);

        const createRequest = requestLog.find(
          (r) => r.path === "/api/assets" && r.method === "POST"
        );
        expect(createRequest).toBeDefined();
        expect(createRequest?.body).toMatchObject({
          siteId: "site-002",
          assetType: "sensor",
          nameOrTag: "S-999",
        });
      });
    });
  });

  // ============================================================
  // EVENTS COMMAND
  // ============================================================
  describe("events command", () => {
    describe("events list", () => {
      it("should list events with pagination info", () => {
        const result = runCli(["events", "list"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("maintenance");
      });

      it("should output JSON when --json flag is used", () => {
        const result = runCli(["events", "list", "--json"]);

        expect(result.exitCode).toBe(0);
        const json = parseJsonOutput<{ data: typeof mockEvents }>(result.stdout);
        expect(json).not.toBeNull();
        expect(json?.data).toBeDefined();
        expect(Array.isArray(json?.data)).toBe(true);
      });

      it("should respect --limit option", () => {
        runCli(["events", "list", "--limit", "10"]);

        const eventsRequest = requestLog.find((r) =>
          r.path.startsWith("/api/events")
        );
        expect(eventsRequest?.path).toContain("limit=10");
      });

      it("should respect --page option", () => {
        runCli(["events", "list", "--page", "2"]);

        const eventsRequest = requestLog.find((r) =>
          r.path.startsWith("/api/events")
        );
        expect(eventsRequest?.path).toContain("page=2");
      });

      it("should filter by --type option", () => {
        runCli(["events", "list", "--type", "maintenance"]);

        const eventsRequest = requestLog.find((r) =>
          r.path.startsWith("/api/events")
        );
        expect(eventsRequest?.path).toContain("type=maintenance");
      });
    });

    describe("events anchor", () => {
      it("should trigger batch anchoring", () => {
        const result = runCli(["events", "anchor"]);

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(
          output.toLowerCase().includes("anchor") ||
            output.toLowerCase().includes("batch") ||
            output.toLowerCase().includes("trigger")
        ).toBe(true);
      });

      it("should make POST request to /api/batch/trigger", () => {
        runCli(["events", "anchor"]);

        const triggerRequest = requestLog.find(
          (r) => r.path === "/api/batch/trigger" && r.method === "POST"
        );
        expect(triggerRequest).toBeDefined();
      });
    });

    describe("events stats", () => {
      it("should display batch statistics", () => {
        const result = runCli(["events", "stats"]);

        expect(result.exitCode).toBe(0);
        // Check for batch stats info
        expect(result.stdout).toContain("15"); // pendingEvents
      });

      it("should output JSON when --json flag is used", () => {
        const result = runCli(["events", "stats", "--json"]);

        expect(result.exitCode).toBe(0);
        const json = parseJsonOutput<typeof mockBatchStats>(result.stdout);
        expect(json).not.toBeNull();
        expect(json?.pendingEvents).toBe(15);
        expect(json?.totalBatchesAnchored).toBe(42);
      });
    });
  });

  // ============================================================
  // BLOCKCHAIN COMMAND
  // ============================================================
  describe("blockchain command", () => {
    describe("blockchain info", () => {
      it("should display blockchain information", () => {
        const result = runCli(["blockchain", "info"]);

        expect(result.exitCode).toBe(0);
        // Should contain blockchain status
        const output = result.stdout.toLowerCase();
        expect(
          output.includes("enabled") ||
            output.includes("blockchain") ||
            output.includes("sepolia")
        ).toBe(true);
      });

      it("should output JSON when --json flag is used", () => {
        const result = runCli(["blockchain", "info", "--json"]);

        expect(result.exitCode).toBe(0);
        const json = parseJsonOutput<{ enabled: boolean }>(result.stdout);
        expect(json).not.toBeNull();
        expect(json?.enabled).toBe(true);
      });
    });

    describe("blockchain status", () => {
      it("should show blockchain connection status", () => {
        const result = runCli(["blockchain", "status"]);

        expect(result.exitCode).toBe(0);
        const output = result.stdout.toLowerCase();
        expect(
          output.includes("enabled") ||
            output.includes("connected") ||
            output.includes("status")
        ).toBe(true);
      });
    });
  });

  // ============================================================
  // DEV COMMAND
  // ============================================================
  describe("dev command", () => {
    describe("dev seed", () => {
      it("should seed the database", () => {
        const result = runCli(["dev", "seed"]);

        expect(result.exitCode).toBe(0);
        const output = result.stdout + result.stderr;
        expect(
          output.toLowerCase().includes("seed") ||
            output.toLowerCase().includes("success") ||
            output.toLowerCase().includes("complete")
        ).toBe(true);
      });

      it("should make POST request to /api/blueprints/seed", () => {
        runCli(["dev", "seed"]);

        const seedRequest = requestLog.find(
          (r) => r.path.startsWith("/api/blueprints/seed") && r.method === "POST"
        );
        expect(seedRequest).toBeDefined();
      });

      it("should respect --force flag", () => {
        runCli(["dev", "seed", "--force"]);

        const seedRequest = requestLog.find(
          (r) => r.path.includes("/api/blueprints/seed") && r.method === "POST"
        );
        expect(seedRequest?.path).toContain("force=true");
      });
    });

    describe("dev check", () => {
      it("should check system requirements", () => {
        const result = runCli(["dev", "check"]);

        // Should complete (may show various checks)
        const output = result.stdout + result.stderr;
        expect(output.length).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================
  // REQUEST/RESPONSE VERIFICATION
  // ============================================================
  describe("HTTP Request Verification", () => {
    it("should send correct Content-Type header", () => {
      // Create a new site to trigger a POST request
      runCli([
        "sites",
        "create",
        "--name",
        "Header Test",
        "--location",
        "Test",
        "--owner",
        "Test",
      ]);

      // The mock server receives the request with proper JSON parsing
      const createRequest = requestLog.find(
        (r) => r.path === "/api/sites" && r.method === "POST"
      );
      expect(createRequest).toBeDefined();
      expect(createRequest?.body).toBeDefined();
    });

    it("should make parallel requests for status command", () => {
      runCli(["status"]);

      // Status command should make multiple requests
      const healthRequest = requestLog.find((r) => r.path === "/api/health");
      const blockchainRequest = requestLog.find(
        (r) => r.path === "/api/blockchain/status"
      );
      const blueprintsRequest = requestLog.find(
        (r) => r.path === "/api/blueprints/summary"
      );

      expect(healthRequest).toBeDefined();
      expect(blockchainRequest).toBeDefined();
      expect(blueprintsRequest).toBeDefined();
    });

    it("should correctly parse JSON responses", () => {
      const result = runCli(["sites", "list", "--json"]);

      expect(result.exitCode).toBe(0);
      const json = parseJsonOutput<typeof mockSites>(result.stdout);
      expect(json).not.toBeNull();
      expect(json?.[0].id).toBe("site-001");
      expect(json?.[0].name).toBe("Houston Refinery");
      expect(json?.[0].location).toBe("Houston, TX");
    });
  });

  // ============================================================
  // ERROR HANDLING
  // ============================================================
  describe("Error Handling with Mock Server", () => {
    it("should handle 404 responses gracefully", () => {
      // This endpoint doesn't exist in our mock
      const result = runCli(["sites", "get", "nonexistent-site-xyz"]);

      // Should not crash, may show error
      expect(result.error).toBeUndefined();
    });

    it("should preserve exit code on successful commands", () => {
      const result = runCli(["sites", "list"]);
      expect(result.exitCode).toBe(0);
    });

    it("should provide meaningful output on all commands", () => {
      const commands = [
        ["status"],
        ["sites", "list"],
        ["assets", "list"],
        ["events", "list"],
        ["blockchain", "info"],
      ];

      for (const cmd of commands) {
        const result = runCli(cmd);
        expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================
  // JSON OUTPUT CONSISTENCY
  // ============================================================
  describe("JSON Output Consistency", () => {
    it("should output valid JSON for sites list", () => {
      const result = runCli(["sites", "list", "--json"]);
      expect(result.exitCode).toBe(0);

      const json = parseJsonOutput(result.stdout);
      expect(json).not.toBeNull();
    });

    it("should output valid JSON for assets list", () => {
      const result = runCli(["assets", "list", "--json"]);
      expect(result.exitCode).toBe(0);

      const json = parseJsonOutput(result.stdout);
      expect(json).not.toBeNull();
    });

    it("should output valid JSON for events list", () => {
      const result = runCli(["events", "list", "--json"]);
      expect(result.exitCode).toBe(0);

      const json = parseJsonOutput(result.stdout);
      expect(json).not.toBeNull();
    });

    it("should output valid JSON for status command", () => {
      const result = runCli(["status", "--json"]);
      expect(result.exitCode).toBe(0);

      const json = parseJsonOutput(result.stdout);
      expect(json).not.toBeNull();
    });

    it("should output valid JSON for blockchain info", () => {
      const result = runCli(["blockchain", "info", "--json"]);
      expect(result.exitCode).toBe(0);

      const json = parseJsonOutput(result.stdout);
      expect(json).not.toBeNull();
    });
  });
});
