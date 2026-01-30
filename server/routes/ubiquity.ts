/**
 * Ubiquity REST API Routes
 * Endpoints for managing Ubiquity cloud domains, devices, file transfers, sessions, and processes
 */

import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  ubiquityDomains,
  ubiquityDevices,
  ubiquityFileTransfers,
  ubiquitySessions,
  ubiquityProcessSnapshots,
} from "../../shared/schema";
import { eq } from "drizzle-orm";
import {
  getUbiquityClient,
  getCredentialsManager,
  getDeviceManager,
  initializeUbiquityService,
  isUbiquityServiceInitialized,
} from "../services/ubiquity";
import type { UbiquityDomainConfig } from "../services/ubiquity";

const router = Router();

// =============================================================================
// MIDDLEWARE: Ensure service is initialized
// =============================================================================

router.use((req, res, next) => {
  if (!isUbiquityServiceInitialized()) {
    initializeUbiquityService();
  }
  next();
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

router.get("/health", async (req: Request, res: Response) => {
  try {
    const client = getUbiquityClient();
    const health = await client.checkHealth();
    res.json({
      service: "ubiquity",
      bridge: health,
      initialized: isUbiquityServiceInitialized(),
    });
  } catch (error: any) {
    res.status(503).json({
      service: "ubiquity",
      bridge: { healthy: false, status: "Error", error: error.message },
      initialized: isUbiquityServiceInitialized(),
    });
  }
});

// =============================================================================
// DOMAIN ENDPOINTS
// =============================================================================

/**
 * List all Ubiquity domains
 */
router.get("/domains", async (req: Request, res: Response) => {
  try {
    const domains = await db.select().from(ubiquityDomains);
    res.json(domains);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Register a new Ubiquity domain
 */
router.post("/domains", async (req: Request, res: Response) => {
  try {
    const { name, displayName, cloudEndpoint, tenantId, username, password, apiKey, siteId, createdBy } = req.body;

    // Store credentials securely
    const credentialsManager = getCredentialsManager();
    const credentialId = await credentialsManager.storeCredentials({
      name: `${name}-credentials`,
      username,
      password,
      apiKey,
      createdBy: createdBy || "system",
    });

    // Create domain record
    const [domain] = await db
      .insert(ubiquityDomains)
      .values({
        name,
        displayName: displayName || name,
        cloudEndpoint,
        tenantId,
        credentialId,
        siteId,
        bridgeEndpoint: process.env.UBIQUITY_BRIDGE_URL || "http://localhost:8080",
      })
      .returning();

    res.status(201).json(domain);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get domain details
 */
router.get("/domains/:domainId", async (req: Request, res: Response) => {
  try {
    const { domainId } = req.params;
    const [domain] = await db
      .select()
      .from(ubiquityDomains)
      .where(eq(ubiquityDomains.id, domainId))
      .limit(1);

    if (!domain) {
      return res.status(404).json({ error: "Domain not found" });
    }

    res.json(domain);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Connect to a domain
 */
router.post("/domains/:domainId/connect", async (req: Request, res: Response) => {
  try {
    const { domainId } = req.params;

    // Get domain from database
    const [domain] = await db
      .select()
      .from(ubiquityDomains)
      .where(eq(ubiquityDomains.id, domainId))
      .limit(1);

    if (!domain) {
      return res.status(404).json({ error: "Domain not found" });
    }

    // Get decrypted credentials
    const credentialsManager = getCredentialsManager();
    const credentials = await credentialsManager.getCredentials(domain.credentialId);

    if (!credentials) {
      return res.status(400).json({ error: "Credentials not found" });
    }

    // Connect via bridge
    const client = getUbiquityClient();
    const config: UbiquityDomainConfig = {
      cloudEndpoint: domain.cloudEndpoint,
      username: credentials.username,
      password: credentials.password,
      apiKey: credentials.apiKey,
      tenantId: domain.tenantId ?? undefined,
    };

    const result = await client.connectDomain(config);

    // Update domain status
    await db
      .update(ubiquityDomains)
      .set({
        status: "ONLINE",
        lastConnected: new Date(),
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(ubiquityDomains.id, domainId));

    res.json(result);
  } catch (error: any) {
    // Update domain with error
    await db
      .update(ubiquityDomains)
      .set({
        status: "ERROR",
        errorMessage: error.message,
        updatedAt: new Date(),
      })
      .where(eq(ubiquityDomains.id, req.params.domainId));

    res.status(500).json({ error: error.message });
  }
});

/**
 * Disconnect from a domain
 */
router.post("/domains/:domainId/disconnect", async (req: Request, res: Response) => {
  try {
    const { domainId } = req.params;

    const client = getUbiquityClient();
    await client.disconnectDomain(domainId);

    await db
      .update(ubiquityDomains)
      .set({
        status: "OFFLINE",
        updatedAt: new Date(),
      })
      .where(eq(ubiquityDomains.id, domainId));

    res.json({ message: "Disconnected successfully" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Sync devices from domain
 */
router.post("/domains/:domainId/devices/sync", async (req: Request, res: Response) => {
  try {
    const { domainId } = req.params;

    const deviceManager = getDeviceManager();
    const result = await deviceManager.discoverAndSync(domainId);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// DEVICE ENDPOINTS
// =============================================================================

/**
 * List all devices
 */
router.get("/devices", async (req: Request, res: Response) => {
  try {
    const { domainId } = req.query;
    const deviceManager = getDeviceManager();
    const devices = await deviceManager.getDevices(domainId as string);
    res.json(devices);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get device details
 */
router.get("/devices/:deviceId", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const deviceManager = getDeviceManager();
    const device = await deviceManager.getDevice(deviceId);

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json(device);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get device status (real-time from bridge)
 */
router.get("/devices/:deviceId/status", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const client = getUbiquityClient();
    const status = await client.getDeviceStatus(deviceId);

    if (!status) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update device
 */
router.put("/devices/:deviceId", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const updates = req.body;

    const deviceManager = getDeviceManager();
    const device = await deviceManager.updateDevice(deviceId, updates);

    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json(device);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete device
 */
router.delete("/devices/:deviceId", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const deviceManager = getDeviceManager();
    const removed = await deviceManager.removeDevice(deviceId);

    if (!removed) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Link device to controller
 */
router.post("/devices/:deviceId/link/controller/:controllerId", async (req: Request, res: Response) => {
  try {
    const { deviceId, controllerId } = req.params;
    const deviceManager = getDeviceManager();
    await deviceManager.linkToController(deviceId, controllerId);
    res.json({ message: "Linked successfully" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Link device to asset
 */
router.post("/devices/:deviceId/link/asset/:assetId", async (req: Request, res: Response) => {
  try {
    const { deviceId, assetId } = req.params;
    const deviceManager = getDeviceManager();
    await deviceManager.linkToAsset(deviceId, assetId);
    res.json({ message: "Linked successfully" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Link device to Digital Twin (AAS)
 */
router.post("/devices/:deviceId/link/aas/:aasId", async (req: Request, res: Response) => {
  try {
    const { deviceId, aasId } = req.params;
    const deviceManager = getDeviceManager();
    await deviceManager.linkToAAS(deviceId, aasId);
    res.json({ message: "Linked successfully" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// FILE TRANSFER ENDPOINTS
// =============================================================================

/**
 * Upload file to device
 */
router.post("/devices/:deviceId/files/upload", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { localPath, remotePath, overwrite } = req.body;

    const client = getUbiquityClient();
    const transfer = await client.uploadFile({
      deviceId,
      localPath,
      remotePath,
      direction: "UPLOAD",
      overwrite,
    });

    // Store transfer in database
    await db.insert(ubiquityFileTransfers).values({
      deviceId,
      direction: "UPLOAD",
      localPath,
      remotePath,
      fileName: localPath.split("/").pop() || "unknown",
      status: "IN_PROGRESS",
      initiatedBy: req.body.initiatedBy || "system",
    });

    res.status(202).json(transfer);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Download file from device
 */
router.post("/devices/:deviceId/files/download", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { localPath, remotePath } = req.body;

    const client = getUbiquityClient();
    const transfer = await client.downloadFile({
      deviceId,
      localPath,
      remotePath,
      direction: "DOWNLOAD",
    });

    // Store transfer in database
    await db.insert(ubiquityFileTransfers).values({
      deviceId,
      direction: "DOWNLOAD",
      localPath,
      remotePath,
      fileName: remotePath.split("/").pop() || "unknown",
      status: "IN_PROGRESS",
      initiatedBy: req.body.initiatedBy || "system",
    });

    res.status(202).json(transfer);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List file transfers
 */
router.get("/transfers", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.query;
    let query = db.select().from(ubiquityFileTransfers);

    if (deviceId) {
      query = query.where(eq(ubiquityFileTransfers.deviceId, deviceId as string)) as typeof query;
    }

    const transfers = await query;
    res.json(transfers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get transfer status
 */
router.get("/transfers/:transferId", async (req: Request, res: Response) => {
  try {
    const { transferId } = req.params;
    const client = getUbiquityClient();
    const transfer = await client.getTransfer(transferId);

    if (!transfer) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    res.json(transfer);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cancel transfer
 */
router.delete("/transfers/:transferId", async (req: Request, res: Response) => {
  try {
    const { transferId } = req.params;
    const client = getUbiquityClient();
    const cancelled = await client.cancelTransfer(transferId);

    if (!cancelled) {
      return res.status(404).json({ error: "Transfer not found" });
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Deploy firmware
 */
router.post("/devices/:deviceId/firmware/deploy", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { firmwarePath, version, forceUpdate, rebootAfterInstall } = req.body;

    const client = getUbiquityClient();
    const deployment = await client.deployFirmware({
      deviceId,
      firmwarePath,
      version,
      forceUpdate,
      rebootAfterInstall,
    });

    res.status(202).json(deployment);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// SESSION ENDPOINTS
// =============================================================================

/**
 * Start remote desktop session
 */
router.post("/devices/:deviceId/sessions/remote-desktop", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { width, height, colorDepth, frameRate, permissions, userId } = req.body;

    const client = getUbiquityClient();
    const session = await client.startSession({
      deviceId,
      sessionType: "REMOTE_DESKTOP",
      width,
      height,
      colorDepth,
      frameRate,
      permissions,
    });

    // Store session in database
    await db.insert(ubiquitySessions).values({
      deviceId,
      sessionType: "REMOTE_DESKTOP",
      ubiquitySessionId: session.ubiquitySessionId,
      status: session.status,
      resolution: session.resolution,
      colorDepth: session.colorDepth,
      frameRate: session.frameRate,
      userId: userId || "system",
      permissions: permissions || ["view"],
      connectedAt: session.connectedAt ? new Date(session.connectedAt) : null,
    });

    res.status(201).json(session);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List active sessions
 */
router.get("/sessions", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.query;
    const client = getUbiquityClient();
    const sessions = await client.listActiveSessions(deviceId as string);
    res.json(sessions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get session details
 */
router.get("/sessions/:sessionId", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const client = getUbiquityClient();
    const session = await client.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json(session);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * End session
 */
router.delete("/sessions/:sessionId", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { reason } = req.query;

    const client = getUbiquityClient();
    await client.endSession(sessionId, reason as string);

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get stream URL
 */
router.get("/sessions/:sessionId/stream", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const client = getUbiquityClient();
    const streamUrl = await client.getStreamUrl(sessionId);

    if (!streamUrl) {
      return res.status(404).json({ error: "Session not found or not connected" });
    }

    res.json({ streamUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send input to session
 */
router.post("/sessions/:sessionId/input", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const event = req.body;

    const client = getUbiquityClient();
    await client.sendInput(sessionId, event);

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// PROCESS MONITORING ENDPOINTS
// =============================================================================

/**
 * Get system metrics
 */
router.get("/devices/:deviceId/metrics", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const client = getUbiquityClient();
    const metrics = await client.getSystemMetrics(deviceId);
    res.json(metrics);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get process list
 */
router.get("/devices/:deviceId/processes", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const client = getUbiquityClient();
    const processes = await client.getProcessList(deviceId);
    res.json(processes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start process
 */
router.post("/devices/:deviceId/processes/start", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { processName, arguments: args } = req.body;

    const client = getUbiquityClient();
    const result = await client.startProcess({
      deviceId,
      processName,
      action: "START",
      arguments: args,
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stop process
 */
router.post("/devices/:deviceId/processes/:pid/stop", async (req: Request, res: Response) => {
  try {
    const { deviceId, pid } = req.params;

    const client = getUbiquityClient();
    const result = await client.stopProcess({
      deviceId,
      pid: parseInt(pid, 10),
      action: "STOP",
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Restart process
 */
router.post("/devices/:deviceId/processes/:pid/restart", async (req: Request, res: Response) => {
  try {
    const { deviceId, pid } = req.params;

    const client = getUbiquityClient();
    const result = await client.restartProcess({
      deviceId,
      pid: parseInt(pid, 10),
      action: "RESTART",
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Capture process snapshot
 */
router.post("/devices/:deviceId/snapshots", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;

    const client = getUbiquityClient();
    const snapshot = await client.captureSnapshot(deviceId);

    // Store snapshot in database
    await db.insert(ubiquityProcessSnapshots).values({
      deviceId,
      processes: snapshot.processes,
      cpuUsage: Math.round(snapshot.systemMetrics.cpuUsage),
      memoryUsage: Math.round(snapshot.systemMetrics.memoryUsage),
      memoryTotal: snapshot.systemMetrics.memoryTotalMb,
      memoryAvailable: snapshot.systemMetrics.memoryAvailableMb,
      diskUsage: Math.round(snapshot.systemMetrics.diskUsage),
      networkUpload: snapshot.systemMetrics.networkUploadBytesPerSec,
      networkDownload: snapshot.systemMetrics.networkDownloadBytesPerSec,
    });

    res.status(201).json(snapshot);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get snapshots for a device
 */
router.get("/devices/:deviceId/snapshots", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { limit = "50" } = req.query;

    const snapshots = await db
      .select()
      .from(ubiquityProcessSnapshots)
      .where(eq(ubiquityProcessSnapshots.deviceId, deviceId))
      .limit(parseInt(limit as string, 10))
      .orderBy(ubiquityProcessSnapshots.capturedAt);

    res.json(snapshots);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
