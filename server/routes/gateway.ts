import express from "express";
import { gatewayManager, type GatewayDriver, type ProtocolConfig, type Tag } from "../gateway";
import { logError } from "../logger";

const router = express.Router();

/**
 * Gateway Routes
 * Provides REST API for gateway protocol drivers
 */

// GET /api/gateway - List all gateway drivers
router.get("/", async (req, res) => {
  try {
    const drivers = gatewayManager.getAllDrivers();
    res.json({
      success: true,
      data: drivers,
      count: drivers.length
    });
  } catch (error) {
    logError("Failed to list gateway drivers:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list gateway drivers"
    });
  }
});

// POST /api/gateway - Create new gateway driver
router.post("/", async (req, res) => {
  try {
    const { id, protocol } = req.body;
    
    if (!id || !protocol) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: id, protocol"
      });
    }

    // Check if driver already exists
    if (gatewayManager.getDriver(id)) {
      return res.status(409).json({
        success: false,
        error: `Driver with id '${id}' already exists`
      });
    }

    const newDriver: GatewayDriver = {
      id,
      protocol: protocol as ProtocolConfig,
      status: 'disconnected',
      lastUpdate: new Date()
    };

    gatewayManager.addDriver(newDriver);
    
    res.status(201).json({
      success: true,
      data: newDriver
    });
  } catch (error) {
    logError("Failed to create gateway driver:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create gateway driver"
    });
  }
});

// GET /api/gateway/:id - Get specific gateway driver
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const driver = gatewayManager.getDriver(id);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: `Driver with id '${id}' not found`
      });
    }

    res.json({
      success: true,
      data: driver
    });
  } catch (error) {
    logError("Failed to get gateway driver:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get gateway driver"
    });
  }
});

// GET /api/gateway/:id/status - Get driver status
router.get("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const driver = gatewayManager.getDriver(id);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: `Driver with id '${id}' not found`
      });
    }

    res.json({
      success: true,
      data: {
        id: driver.id,
        status: driver.status,
        protocol: driver.protocol.type,
        lastUpdate: driver.lastUpdate
      }
    });
  } catch (error) {
    logError("Failed to get driver status:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get driver status"
    });
  }
});

// POST /api/gateway/:id/read - Read tags from driver
router.post("/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    const { tagAddresses } = req.body;
    
    const driver = gatewayManager.getDriver(id);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: `Driver with id '${id}' not found`
      });
    }

    if (driver.status !== 'connected') {
      return res.status(503).json({
        success: false,
        error: "Driver is not connected"
      });
    }

    // Mock tag reading - in real implementation, this would read from actual devices
    const tags: Tag[] = (tagAddresses || []).map((address: string, index: number) => ({
      id: `${id}-tag-${index}`,
      name: `Tag_${index}`,
      address,
      dataType: 'number' as const,
      value: Math.random() * 100,
      quality: 'good' as const,
      timestamp: new Date()
    }));

    res.json({
      success: true,
      data: tags,
      count: tags.length
    });
  } catch (error) {
    logError("Failed to read tags:", error);
    res.status(500).json({
      success: false,
      error: "Failed to read tags"
    });
  }
});

// POST /api/gateway/:id/write - Write tags to driver
router.post("/:id/write", async (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;
    
    const driver = gatewayManager.getDriver(id);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: `Driver with id '${id}' not found`
      });
    }

    if (driver.status !== 'connected') {
      return res.status(503).json({
        success: false,
        error: "Driver is not connected"
      });
    }

    if (!tags || !Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: "Invalid tags array"
      });
    }

    // Mock tag writing - in real implementation, this would write to actual devices
    const writtenTags = tags.map((tag: Partial<Tag>) => ({
      ...tag,
      quality: 'good' as const,
      timestamp: new Date()
    }));

    res.json({
      success: true,
      data: writtenTags,
      count: writtenTags.length
    });
  } catch (error) {
    logError("Failed to write tags:", error);
    res.status(500).json({
      success: false,
      error: "Failed to write tags"
    });
  }
});

// DELETE /api/gateway/:id - Remove gateway driver
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const removed = gatewayManager.removeDriver(id);
    
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Driver with id '${id}' not found`
      });
    }

    res.json({
      success: true,
      message: `Driver '${id}' removed successfully`
    });
  } catch (error) {
    logError("Failed to remove gateway driver:", error);
    res.status(500).json({
      success: false,
      error: "Failed to remove gateway driver"
    });
  }
});

export { router as gatewayRoutes };