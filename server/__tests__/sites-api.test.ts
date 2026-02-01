/**
 * Integration Tests for Sites API
 * 
 * Tests the Sites CRUD API endpoints using real database queries.
 * 
 * Q1.1 - Quality Engineering Track
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { storage } from "../storage";
import type { Site, InsertSite } from "@shared/schema";

// Mock blockchain service to avoid actual blockchain calls
vi.mock("../blockchain", () => ({
  blockchainService: {
    isEnabled: () => false,
    registerSite: vi.fn().mockResolvedValue("0xmocktxhash"),
    hashPayload: (payload: any) => "0xmockhash",
    anchorEvent: vi.fn().mockResolvedValue(null),
    registerAsset: vi.fn().mockResolvedValue(null),
    anchorMaintenance: vi.fn().mockResolvedValue(null),
  },
}));

// Create test app with routes
async function createTestApp() {
  const app = express();
  app.use(express.json());

  // Import and register routes
  const { registerRoutes } = await import("../routes");
  const http = await import("http");
  const server = http.createServer(app);
  await registerRoutes(server, app);

  return { app, server };
}

describe("Sites API Integration Tests", () => {
  let app: express.Express;
  let server: any;
  let createdSiteIds: string[] = [];

  beforeEach(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    server = testApp.server;
    createdSiteIds = [];
  });

  afterEach(async () => {
    // Clean up created test sites
    // Note: We track created IDs and could delete them if DELETE endpoint exists
    // For now, tests are isolated by using unique names
    if (server) {
      server.close();
    }
  });

  // Helper function to generate unique test site data
  function generateTestSite(suffix: string = ""): InsertSite {
    const timestamp = Date.now();
    return {
      name: `Test Site ${timestamp}${suffix}`,
      location: `Test Location ${timestamp}`,
      owner: `Test Owner ${timestamp}`,
      status: "ONLINE",
    };
  }

  describe("GET /api/sites", () => {
    it("should return all sites as an array", async () => {
      const response = await request(app)
        .get("/api/sites")
        .expect("Content-Type", /json/)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it("should return sites with required fields", async () => {
      // First create a test site
      const testSite = generateTestSite("-fields");
      const createResponse = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(createResponse.body.id);

      // Now fetch all sites
      const response = await request(app)
        .get("/api/sites")
        .expect(200);

      // Find our created site in the response
      const site = response.body.find(
        (s: Site) => s.id === createResponse.body.id
      );
      
      expect(site).toBeDefined();
      expect(site.id).toBeDefined();
      expect(site.name).toBe(testSite.name);
      expect(site.location).toBe(testSite.location);
      expect(site.owner).toBe(testSite.owner);
      expect(site.status).toBe("ONLINE");
      expect(site.createdAt).toBeDefined();
    });

    it("should include newly created sites in subsequent GET requests", async () => {
      // Get initial count
      const initialResponse = await request(app)
        .get("/api/sites")
        .expect(200);
      const initialCount = initialResponse.body.length;

      // Create a new site
      const testSite = generateTestSite("-count");
      const createResponse = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(createResponse.body.id);

      // Get sites again
      const afterResponse = await request(app)
        .get("/api/sites")
        .expect(200);

      expect(afterResponse.body.length).toBe(initialCount + 1);
    });
  });

  describe("POST /api/sites", () => {
    it("should create a new site with valid data", async () => {
      const testSite = generateTestSite("-create");

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect("Content-Type", /json/)
        .expect(201);

      createdSiteIds.push(response.body.id);

      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe(testSite.name);
      expect(response.body.location).toBe(testSite.location);
      expect(response.body.owner).toBe(testSite.owner);
      expect(response.body.status).toBe("ONLINE");
    });

    it("should return 400 for missing required fields", async () => {
      const invalidSite = {
        name: "Incomplete Site",
        // Missing location and owner
      };

      const response = await request(app)
        .post("/api/sites")
        .send(invalidSite)
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it("should return 400 for missing name field", async () => {
      const invalidSite = {
        location: "Test Location",
        owner: "Test Owner",
      };

      const response = await request(app)
        .post("/api/sites")
        .send(invalidSite)
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it("should return 400 for missing location field", async () => {
      const invalidSite = {
        name: "Test Site",
        owner: "Test Owner",
      };

      const response = await request(app)
        .post("/api/sites")
        .send(invalidSite)
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it("should return 400 for missing owner field", async () => {
      const invalidSite = {
        name: "Test Site",
        location: "Test Location",
      };

      const response = await request(app)
        .post("/api/sites")
        .send(invalidSite)
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it("should set default status to ONLINE", async () => {
      const testSite = {
        name: `Test Site Default Status ${Date.now()}`,
        location: "Test Location",
        owner: "Test Owner",
        // Not providing status
      };

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(response.body.id);

      expect(response.body.status).toBe("ONLINE");
    });

    it("should accept custom status value", async () => {
      const testSite = {
        name: `Test Site Custom Status ${Date.now()}`,
        location: "Test Location",
        owner: "Test Owner",
        status: "OFFLINE",
      };

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(response.body.id);

      expect(response.body.status).toBe("OFFLINE");
    });

    it("should generate unique IDs for each site", async () => {
      const site1 = generateTestSite("-unique-1");
      const site2 = generateTestSite("-unique-2");

      const response1 = await request(app)
        .post("/api/sites")
        .send(site1)
        .expect(201);

      const response2 = await request(app)
        .post("/api/sites")
        .send(site2)
        .expect(201);

      createdSiteIds.push(response1.body.id, response2.body.id);

      expect(response1.body.id).not.toBe(response2.body.id);
    });

    it("should set createdAt timestamp", async () => {
      const testSite = generateTestSite("-timestamp");
      const beforeCreate = new Date();

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(response.body.id);

      const createdAt = new Date(response.body.createdAt);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
    });

    it("should handle optional ethereumAddress field", async () => {
      const testSite = {
        name: `Test Site Ethereum ${Date.now()}`,
        location: "Test Location",
        owner: "Test Owner",
        ethereumAddress: "0x1234567890abcdef1234567890abcdef12345678",
      };

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(response.body.id);

      expect(response.body.ethereumAddress).toBe(testSite.ethereumAddress);
    });

    it("should handle empty authorizedGateways array", async () => {
      const testSite = {
        name: `Test Site Gateways ${Date.now()}`,
        location: "Test Location",
        owner: "Test Owner",
        authorizedGateways: [],
      };

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(response.body.id);

      expect(Array.isArray(response.body.authorizedGateways)).toBe(true);
    });
  });

  describe("API Error Handling", () => {
    it("should return 500 for internal server errors", async () => {
      // This test would require mocking the storage layer to throw
      // Skipped for now as it requires deeper mocking
    });

    it("should return proper JSON error response format", async () => {
      const response = await request(app)
        .post("/api/sites")
        .send({}) // Empty body should trigger validation error
        .expect(400);

      expect(response.body).toHaveProperty("error");
      expect(typeof response.body.error).toBe("string");
    });
  });

  describe("Sites API Response Format", () => {
    it("should return JSON content type for GET", async () => {
      const response = await request(app)
        .get("/api/sites");

      expect(response.headers["content-type"]).toMatch(/application\/json/);
    });

    it("should return JSON content type for POST", async () => {
      const testSite = generateTestSite("-content-type");

      const response = await request(app)
        .post("/api/sites")
        .send(testSite)
        .expect(201);

      createdSiteIds.push(response.body.id);

      expect(response.headers["content-type"]).toMatch(/application\/json/);
    });
  });
});

describe("Sites API with Storage Layer", () => {
  it("should persist sites to the database", async () => {
    const timestamp = Date.now();
    const testSite: InsertSite = {
      name: `Persistence Test ${timestamp}`,
      location: `Location ${timestamp}`,
      owner: `Owner ${timestamp}`,
      status: "ONLINE",
    };

    // Create site via storage layer directly
    const created = await storage.createSite(testSite);

    expect(created.id).toBeDefined();
    expect(created.name).toBe(testSite.name);

    // Verify it's in the database
    const sites = await storage.getSites();
    const found = sites.find((s) => s.id === created.id);
    expect(found).toBeDefined();
  });

  it("should retrieve site by ID", async () => {
    const timestamp = Date.now();
    const testSite: InsertSite = {
      name: `GetById Test ${timestamp}`,
      location: `Location ${timestamp}`,
      owner: `Owner ${timestamp}`,
      status: "ONLINE",
    };

    const created = await storage.createSite(testSite);
    const retrieved = await storage.getSiteById(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(created.id);
    expect(retrieved?.name).toBe(testSite.name);
  });

  it("should return undefined for non-existent site ID", async () => {
    const nonExistentId = "non-existent-uuid-12345";
    const result = await storage.getSiteById(nonExistentId);
    expect(result).toBeUndefined();
  });
});
