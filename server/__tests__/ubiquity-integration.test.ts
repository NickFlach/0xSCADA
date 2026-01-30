/**
 * Ubiquity Integration Tests
 *
 * Tests the Ubiquity service integration with real database operations.
 * Per CLAUDE.md integrity rules: uses real database, not mocks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "../db";
import {
  sites,
  controllers,
  assets,
  ubiquityCredentials,
  ubiquityDomains,
  ubiquityDevices,
  ubiquityFileTransfers,
  ubiquitySessions,
  ubiquityProcessSnapshots,
  vendors,
} from "../../shared/schema";
import { eq, sql } from "drizzle-orm";
import { CredentialsManager } from "../services/ubiquity/credentials-manager";
import { DeviceManager } from "../services/ubiquity/device-manager";
import { initializeUbiquityClient, UbiquityBridgeClient } from "../services/ubiquity/ubiquity-client";

// =============================================================================
// TEST SETUP
// =============================================================================

let testSiteId: string;
let testControllerId: string;
let testAssetId: string;
let testVendorId: string;
let testCredentialId: string;
let testDomainId: string;
let testDeviceId: string;

describe("Ubiquity Integration Tests", () => {
  beforeAll(async () => {
    // Seed test data
    console.log("Setting up test data...");

    // Create test site
    const [site] = await db
      .insert(sites)
      .values({
        name: "Ubiquity Test Site",
        location: "Test Facility",
        owner: "Test Owner",
        status: "ONLINE",
      })
      .returning();
    testSiteId = site.id;

    // Create test vendor (Rockwell)
    const [vendor] = await db
      .insert(vendors)
      .values({
        name: "rockwell-test",
        displayName: "Rockwell Automation (Test)",
        platforms: ["Studio 5000", "FactoryTalk"],
        languages: ["Ladder", "ST", "FBD"],
      })
      .returning();
    testVendorId = vendor.id;

    // Create test controller
    const [controller] = await db
      .insert(controllers)
      .values({
        name: "Test ControlLogix",
        vendorId: testVendorId,
        siteId: testSiteId,
        model: "1756-L85E",
        firmwareVersion: "33.011",
        address: "192.168.1.100",
        status: "online",
      })
      .returning();
    testControllerId = controller.id;

    // Create test asset
    const [asset] = await db
      .insert(assets)
      .values({
        siteId: testSiteId,
        assetType: "PLC",
        nameOrTag: "MAIN_PLC",
        critical: true,
        status: "OK",
      })
      .returning();
    testAssetId = asset.id;

    console.log("Test data created successfully");
  });

  afterAll(async () => {
    // Cleanup test data
    console.log("Cleaning up test data...");

    // Delete in reverse order of dependencies
    if (testDeviceId) {
      await db.delete(ubiquityProcessSnapshots).where(eq(ubiquityProcessSnapshots.deviceId, testDeviceId));
      await db.delete(ubiquitySessions).where(eq(ubiquitySessions.deviceId, testDeviceId));
      await db.delete(ubiquityFileTransfers).where(eq(ubiquityFileTransfers.deviceId, testDeviceId));
      await db.delete(ubiquityDevices).where(eq(ubiquityDevices.id, testDeviceId));
    }
    if (testDomainId) {
      await db.delete(ubiquityDomains).where(eq(ubiquityDomains.id, testDomainId));
    }
    if (testCredentialId) {
      await db.delete(ubiquityCredentials).where(eq(ubiquityCredentials.id, testCredentialId));
    }
    if (testAssetId) {
      await db.delete(assets).where(eq(assets.id, testAssetId));
    }
    if (testControllerId) {
      await db.delete(controllers).where(eq(controllers.id, testControllerId));
    }
    if (testVendorId) {
      await db.delete(vendors).where(eq(vendors.id, testVendorId));
    }
    if (testSiteId) {
      await db.delete(sites).where(eq(sites.id, testSiteId));
    }

    console.log("Cleanup completed");
  });

  // ===========================================================================
  // CREDENTIALS MANAGER TESTS
  // ===========================================================================

  describe("CredentialsManager", () => {
    it("should encrypt and store credentials", async () => {
      const credManager = new CredentialsManager();

      testCredentialId = await credManager.storeCredentials({
        name: "test-ubiquity-creds",
        username: "testuser@rockwell.com",
        password: "SecureP@ssw0rd!",
        apiKey: "test-api-key-12345",
        createdBy: "test-suite",
      });

      expect(testCredentialId).toBeDefined();
      expect(typeof testCredentialId).toBe("string");

      // Verify stored in database
      const [stored] = await db
        .select()
        .from(ubiquityCredentials)
        .where(eq(ubiquityCredentials.id, testCredentialId))
        .limit(1);

      expect(stored).toBeDefined();
      expect(stored.name).toBe("test-ubiquity-creds");
      expect(stored.encryptedUsername).not.toBe("testuser@rockwell.com"); // Should be encrypted
      expect(stored.encryptedPassword).not.toBe("SecureP@ssw0rd!"); // Should be encrypted
    });

    it("should decrypt and retrieve credentials", async () => {
      const credManager = new CredentialsManager();

      const decrypted = await credManager.getCredentials(testCredentialId);

      expect(decrypted).toBeDefined();
      expect(decrypted!.username).toBe("testuser@rockwell.com");
      expect(decrypted!.password).toBe("SecureP@ssw0rd!");
      expect(decrypted!.apiKey).toBe("test-api-key-12345");
    });

    it("should list credentials without exposing sensitive data", async () => {
      const credManager = new CredentialsManager();

      const list = await credManager.listCredentials();

      expect(list.length).toBeGreaterThan(0);
      const testCred = list.find((c) => c.id === testCredentialId);
      expect(testCred).toBeDefined();
      expect(testCred!.name).toBe("test-ubiquity-creds");
      // Should NOT expose password/username in list
      expect((testCred as any).password).toBeUndefined();
      expect((testCred as any).username).toBeUndefined();
    });

    it("should rotate credentials", async () => {
      const credManager = new CredentialsManager();

      await credManager.rotateCredentials(testCredentialId, "NewP@ssw0rd!!");

      const decrypted = await credManager.getCredentials(testCredentialId);
      expect(decrypted!.password).toBe("NewP@ssw0rd!!");
      // Username should remain unchanged
      expect(decrypted!.username).toBe("testuser@rockwell.com");
    });
  });

  // ===========================================================================
  // DOMAIN MANAGEMENT TESTS
  // ===========================================================================

  describe("Domain Management", () => {
    it("should create a Ubiquity domain", async () => {
      const [domain] = await db
        .insert(ubiquityDomains)
        .values({
          name: "test-domain",
          displayName: "Test Ubiquity Domain",
          description: "A test domain for integration testing",
          cloudEndpoint: "https://ubiquity-test.rockwell.com",
          tenantId: "test-tenant-001",
          credentialId: testCredentialId,
          siteId: testSiteId,
          status: "OFFLINE",
          bridgeEndpoint: "http://localhost:8080",
        })
        .returning();

      testDomainId = domain.id;

      expect(testDomainId).toBeDefined();
      expect(domain.name).toBe("test-domain");
      expect(domain.status).toBe("OFFLINE");
    });

    it("should retrieve domain details", async () => {
      const [domain] = await db
        .select()
        .from(ubiquityDomains)
        .where(eq(ubiquityDomains.id, testDomainId))
        .limit(1);

      expect(domain).toBeDefined();
      expect(domain.cloudEndpoint).toBe("https://ubiquity-test.rockwell.com");
      expect(domain.credentialId).toBe(testCredentialId);
    });

    it("should update domain status", async () => {
      await db
        .update(ubiquityDomains)
        .set({
          status: "ONLINE",
          lastConnected: new Date(),
        })
        .where(eq(ubiquityDomains.id, testDomainId));

      const [updated] = await db
        .select()
        .from(ubiquityDomains)
        .where(eq(ubiquityDomains.id, testDomainId))
        .limit(1);

      expect(updated.status).toBe("ONLINE");
      expect(updated.lastConnected).toBeDefined();
    });
  });

  // ===========================================================================
  // DEVICE MANAGEMENT TESTS
  // ===========================================================================

  describe("Device Management", () => {
    it("should create a Ubiquity device", async () => {
      const [device] = await db
        .insert(ubiquityDevices)
        .values({
          domainId: testDomainId,
          ubiquityDeviceId: "UBQ-TEST-001",
          name: "Test ControlLogix 5580",
          displayName: "Main Production PLC",
          description: "Test device for integration testing",
          deviceType: "PLC",
          model: "1756-L85E",
          serialNumber: "SN-TEST-001",
          firmwareVersion: "33.011",
          ipAddress: "192.168.1.100",
          macAddress: "00:1A:2B:3C:4D:5E",
          connectionStatus: "ONLINE",
          lastSeen: new Date(),
          supportsRemoteDesktop: false,
          supportsFileTransfer: true,
          supportsProcessMonitor: true,
          metadata: { customField: "testValue" },
        })
        .returning();

      testDeviceId = device.id;

      expect(testDeviceId).toBeDefined();
      expect(device.name).toBe("Test ControlLogix 5580");
      expect(device.connectionStatus).toBe("ONLINE");
      expect(device.supportsFileTransfer).toBe(true);
    });

    it("should link device to controller", async () => {
      await db
        .update(ubiquityDevices)
        .set({ controllerId: testControllerId })
        .where(eq(ubiquityDevices.id, testDeviceId));

      const [updated] = await db
        .select()
        .from(ubiquityDevices)
        .where(eq(ubiquityDevices.id, testDeviceId))
        .limit(1);

      expect(updated.controllerId).toBe(testControllerId);
    });

    it("should link device to asset", async () => {
      await db
        .update(ubiquityDevices)
        .set({ assetId: testAssetId })
        .where(eq(ubiquityDevices.id, testDeviceId));

      const [updated] = await db
        .select()
        .from(ubiquityDevices)
        .where(eq(ubiquityDevices.id, testDeviceId))
        .limit(1);

      expect(updated.assetId).toBe(testAssetId);
    });

    it("should query devices by domain", async () => {
      const devices = await db
        .select()
        .from(ubiquityDevices)
        .where(eq(ubiquityDevices.domainId, testDomainId));

      expect(devices.length).toBeGreaterThan(0);
      expect(devices[0].domainId).toBe(testDomainId);
    });
  });

  // ===========================================================================
  // FILE TRANSFER TESTS
  // ===========================================================================

  describe("File Transfer Tracking", () => {
    it("should create file transfer record", async () => {
      const [transfer] = await db
        .insert(ubiquityFileTransfers)
        .values({
          deviceId: testDeviceId,
          direction: "UPLOAD",
          localPath: "/tmp/config.xml",
          remotePath: "/opt/rockwell/config.xml",
          fileName: "config.xml",
          fileSize: 4096,
          status: "COMPLETED",
          progress: 100,
          bytesTransferred: 4096,
          initiatedBy: "test-user",
          startedAt: new Date(Date.now() - 10000),
          completedAt: new Date(),
        })
        .returning();

      expect(transfer).toBeDefined();
      expect(transfer.direction).toBe("UPLOAD");
      expect(transfer.status).toBe("COMPLETED");
      expect(transfer.progress).toBe(100);
    });

    it("should track transfer progress", async () => {
      const [inProgress] = await db
        .insert(ubiquityFileTransfers)
        .values({
          deviceId: testDeviceId,
          direction: "DOWNLOAD",
          localPath: "/tmp/logs.tar",
          remotePath: "/var/log/plc.tar",
          fileName: "plc.tar",
          fileSize: 1048576,
          status: "IN_PROGRESS",
          progress: 50,
          bytesTransferred: 524288,
          initiatedBy: "test-user",
          startedAt: new Date(),
        })
        .returning();

      expect(inProgress.status).toBe("IN_PROGRESS");
      expect(inProgress.progress).toBe(50);

      // Update progress
      await db
        .update(ubiquityFileTransfers)
        .set({
          progress: 100,
          bytesTransferred: 1048576,
          status: "COMPLETED",
          completedAt: new Date(),
        })
        .where(eq(ubiquityFileTransfers.id, inProgress.id));

      const [completed] = await db
        .select()
        .from(ubiquityFileTransfers)
        .where(eq(ubiquityFileTransfers.id, inProgress.id))
        .limit(1);

      expect(completed.status).toBe("COMPLETED");
      expect(completed.progress).toBe(100);
    });
  });

  // ===========================================================================
  // PROCESS SNAPSHOT TESTS
  // ===========================================================================

  describe("Process Monitoring", () => {
    it("should store process snapshot", async () => {
      const processes = [
        { pid: 1, name: "init", cpuPercent: 0.1, memoryBytes: 4096 },
        { pid: 100, name: "PLCEngine", cpuPercent: 25.0, memoryBytes: 524288 },
        { pid: 200, name: "UbiquityAgent", cpuPercent: 2.5, memoryBytes: 65536 },
      ];

      const [snapshot] = await db
        .insert(ubiquityProcessSnapshots)
        .values({
          deviceId: testDeviceId,
          processes,
          cpuUsage: 35,
          memoryUsage: 60,
          memoryTotal: 8192,
          memoryAvailable: 3276,
          diskUsage: 45,
          networkUpload: 100000,
          networkDownload: 500000,
        })
        .returning();

      expect(snapshot).toBeDefined();
      expect(snapshot.cpuUsage).toBe(35);
      expect(snapshot.processes).toHaveLength(3);
    });

    it("should query snapshots for a device", async () => {
      const snapshots = await db
        .select()
        .from(ubiquityProcessSnapshots)
        .where(eq(ubiquityProcessSnapshots.deviceId, testDeviceId))
        .limit(10);

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].deviceId).toBe(testDeviceId);
    });
  });

  // ===========================================================================
  // SCHEMA RELATIONSHIP TESTS
  // ===========================================================================

  describe("Schema Relationships", () => {
    it("should enforce domain-credential relationship", async () => {
      // Domain should reference valid credential
      const [domain] = await db
        .select()
        .from(ubiquityDomains)
        .where(eq(ubiquityDomains.id, testDomainId))
        .limit(1);

      const [credential] = await db
        .select()
        .from(ubiquityCredentials)
        .where(eq(ubiquityCredentials.id, domain.credentialId))
        .limit(1);

      expect(credential).toBeDefined();
    });

    it("should enforce device-domain relationship", async () => {
      // Device should reference valid domain
      const [device] = await db
        .select()
        .from(ubiquityDevices)
        .where(eq(ubiquityDevices.id, testDeviceId))
        .limit(1);

      const [domain] = await db
        .select()
        .from(ubiquityDomains)
        .where(eq(ubiquityDomains.id, device.domainId))
        .limit(1);

      expect(domain).toBeDefined();
    });

    it("should link device to 0xSCADA entities", async () => {
      const [device] = await db
        .select()
        .from(ubiquityDevices)
        .where(eq(ubiquityDevices.id, testDeviceId))
        .limit(1);

      // Verify controller link
      if (device.controllerId) {
        const [controller] = await db
          .select()
          .from(controllers)
          .where(eq(controllers.id, device.controllerId))
          .limit(1);
        expect(controller).toBeDefined();
      }

      // Verify asset link
      if (device.assetId) {
        const [asset] = await db
          .select()
          .from(assets)
          .where(eq(assets.id, device.assetId))
          .limit(1);
        expect(asset).toBeDefined();
      }
    });
  });
});
