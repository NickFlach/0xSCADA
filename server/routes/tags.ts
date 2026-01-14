/**
 * Tag Subscription API
 *
 * VS-1.3 - Vertical Slice: Tag Subscription API
 *
 * REST and WebSocket endpoints for real-time tag data subscriptions.
 */

import { Router, type Request, type Response } from "express";
import type { WebSocket } from "ws";
import { createModbusDriver, type RealModbusTcpDriver } from "../gateway/modbus-driver";
import { createGateway, gatewayRegistry, type TagDefinition, type TagValue } from "../gateway";

// =============================================================================
// TYPES
// =============================================================================

interface TagSubscription {
  id: string;
  tags: string[];
  clientWs?: WebSocket;
  callback?: (values: TagValue[]) => void;
}

interface TagConfig {
  name: string;
  address: string;
  unit?: string;
  scanRate?: number;
  deadband?: number;
  alarmConfig?: {
    highHigh?: number;
    high?: number;
    low?: number;
    lowLow?: number;
  };
}

// =============================================================================
// TAG SERVICE
// =============================================================================

class TagService {
  private driver: RealModbusTcpDriver | null = null;
  private tags: Map<string, TagDefinition> = new Map();
  private subscriptions: Map<string, TagSubscription> = new Map();
  private wsClients: Set<WebSocket> = new Set();
  private lastValues: Map<string, TagValue> = new Map();
  private connected = false;

  /**
   * Initialize connection to Modbus simulator/device
   */
  async connect(host: string, port: number = 5020): Promise<void> {
    console.log(`[TagService] Connecting to ${host}:${port}...`);

    this.driver = createModbusDriver(host, port);

    try {
      await this.driver.connect();
      this.connected = true;
      console.log(`[TagService] Connected`);

      // Start polling registered tags
      if (this.tags.size > 0) {
        this.startPolling();
      }
    } catch (error) {
      console.error(`[TagService] Connection failed:`, error);
      throw error;
    }
  }

  /**
   * Disconnect from device
   */
  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.disconnect();
      this.driver = null;
      this.connected = false;
    }
  }

  /**
   * Register tags to monitor
   */
  registerTags(configs: TagConfig[]): void {
    for (const config of configs) {
      const tagDef: TagDefinition = {
        name: config.name,
        address: config.address,
        dataType: "REAL", // Default to REAL for analog values
        scanRate: config.scanRate || 1000,
        deadband: config.deadband,
        unit: config.unit,
        alarmConfig: config.alarmConfig,
      };
      this.tags.set(config.name, tagDef);
    }

    console.log(`[TagService] Registered ${configs.length} tags`);

    // Restart polling if connected
    if (this.connected && this.driver) {
      this.startPolling();
    }
  }

  /**
   * Start polling all registered tags
   */
  private startPolling(): void {
    if (!this.driver) return;

    const tagArray = Array.from(this.tags.values());

    this.driver.subscribe(tagArray, (values) => {
      this.handleTagValues(values);
    });
  }

  /**
   * Handle incoming tag values
   */
  private handleTagValues(values: TagValue[]): void {
    for (const value of values) {
      this.lastValues.set(value.tag, value);
    }

    // Broadcast to all WebSocket clients
    const message = JSON.stringify({
      type: "tag_values",
      timestamp: new Date().toISOString(),
      values: values.map((v) => ({
        tag: v.tag,
        value: v.value,
        quality: v.quality,
        timestamp: v.timestamp.toISOString(),
        unit: v.unit,
      })),
    });

    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        ws.send(message);
      }
    }

    // Call subscription callbacks
    for (const sub of this.subscriptions.values()) {
      const relevantValues = values.filter((v) => sub.tags.includes(v.tag));
      if (relevantValues.length > 0 && sub.callback) {
        sub.callback(relevantValues);
      }
    }
  }

  /**
   * Get current value of a tag
   */
  getTagValue(tagName: string): TagValue | null {
    return this.lastValues.get(tagName) || null;
  }

  /**
   * Get all current tag values
   */
  getAllTagValues(): TagValue[] {
    return Array.from(this.lastValues.values());
  }

  /**
   * Get registered tag definitions
   */
  getTagDefinitions(): TagDefinition[] {
    return Array.from(this.tags.values());
  }

  /**
   * Write a value to a tag
   */
  async writeTag(tagName: string, value: number | boolean): Promise<boolean> {
    const tagDef = this.tags.get(tagName);
    if (!tagDef) {
      throw new Error(`Unknown tag: ${tagName}`);
    }

    if (!this.driver || !this.connected) {
      throw new Error("Not connected");
    }

    return this.driver.writeTag(tagDef.address, value);
  }

  /**
   * Add WebSocket client for real-time updates
   */
  addWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);

    // Send current values immediately
    const currentValues = this.getAllTagValues();
    if (currentValues.length > 0) {
      ws.send(
        JSON.stringify({
          type: "tag_values",
          timestamp: new Date().toISOString(),
          values: currentValues.map((v) => ({
            tag: v.tag,
            value: v.value,
            quality: v.quality,
            timestamp: v.timestamp.toISOString(),
            unit: v.unit,
          })),
        })
      );
    }

    console.log(`[TagService] WebSocket client added (${this.wsClients.size} total)`);
  }

  /**
   * Remove WebSocket client
   */
  removeWsClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
    console.log(`[TagService] WebSocket client removed (${this.wsClients.size} total)`);
  }

  /**
   * Get service status
   */
  getStatus(): Record<string, unknown> {
    return {
      connected: this.connected,
      registeredTags: this.tags.size,
      wsClients: this.wsClients.size,
      subscriptions: this.subscriptions.size,
      driver: this.driver?.getStatus() || null,
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const tagService = new TagService();

// =============================================================================
// REST ROUTES
// =============================================================================

export const tagRoutes = Router();

/**
 * GET /api/tags
 * List all registered tags with current values
 */
tagRoutes.get("/", (_req: Request, res: Response) => {
  const tags = tagService.getTagDefinitions();
  const values = tagService.getAllTagValues();

  const result = tags.map((tag) => {
    const value = values.find((v) => v.tag === tag.name);
    return {
      name: tag.name,
      address: tag.address,
      unit: tag.unit,
      scanRate: tag.scanRate,
      deadband: tag.deadband,
      alarmConfig: tag.alarmConfig,
      currentValue: value
        ? {
            value: value.value,
            quality: value.quality,
            timestamp: value.timestamp,
          }
        : null,
    };
  });

  res.json(result);
});

/**
 * GET /api/tags/:name
 * Get current value of a specific tag
 */
tagRoutes.get("/:name", (req: Request, res: Response) => {
  const { name } = req.params;
  const value = tagService.getTagValue(name);

  if (!value) {
    res.status(404).json({ error: `Tag not found: ${name}` });
    return;
  }

  res.json({
    tag: value.tag,
    value: value.value,
    quality: value.quality,
    timestamp: value.timestamp,
    unit: value.unit,
  });
});

/**
 * POST /api/tags/:name/write
 * Write a value to a tag
 */
tagRoutes.post("/:name/write", async (req: Request, res: Response) => {
  const { name } = req.params;
  const { value } = req.body;

  if (value === undefined) {
    res.status(400).json({ error: "Value is required" });
    return;
  }

  try {
    const success = await tagService.writeTag(name, value);
    res.json({ success, tag: name, value });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/tags/register
 * Register tags to monitor
 */
tagRoutes.post("/register", (req: Request, res: Response) => {
  const { tags } = req.body;

  if (!Array.isArray(tags)) {
    res.status(400).json({ error: "Tags array is required" });
    return;
  }

  tagService.registerTags(tags);
  res.json({ success: true, registered: tags.length });
});

/**
 * GET /api/tags/status
 * Get tag service status
 */
tagRoutes.get("/service/status", (_req: Request, res: Response) => {
  res.json(tagService.getStatus());
});

/**
 * POST /api/tags/connect
 * Connect to Modbus device
 */
tagRoutes.post("/connect", async (req: Request, res: Response) => {
  const { host, port } = req.body;

  if (!host) {
    res.status(400).json({ error: "Host is required" });
    return;
  }

  try {
    await tagService.connect(host, port || 5020);
    res.json({ success: true, status: tagService.getStatus() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/tags/disconnect
 * Disconnect from Modbus device
 */
tagRoutes.post("/disconnect", async (_req: Request, res: Response) => {
  try {
    await tagService.disconnect();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// =============================================================================
// WEBSOCKET HANDLER
// =============================================================================

/**
 * Handle WebSocket connection for real-time tag updates
 */
export function handleTagWebSocket(ws: WebSocket): void {
  console.log(`[TagWS] New WebSocket connection`);

  tagService.addWsClient(ws);

  // Send initial status
  ws.send(
    JSON.stringify({
      type: "connected",
      status: tagService.getStatus(),
    })
  );

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case "subscribe":
          // Client wants to subscribe to specific tags
          console.log(`[TagWS] Subscribe request:`, message.tags);
          break;

        case "write":
          // Client wants to write a tag value
          tagService
            .writeTag(message.tag, message.value)
            .then((success) => {
              ws.send(JSON.stringify({ type: "write_result", success, tag: message.tag }));
            })
            .catch((error) => {
              ws.send(JSON.stringify({ type: "write_error", error: error.message, tag: message.tag }));
            });
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          break;
      }
    } catch (error) {
      console.error(`[TagWS] Message parse error:`, error);
    }
  });

  ws.on("close", () => {
    console.log(`[TagWS] WebSocket closed`);
    tagService.removeWsClient(ws);
  });

  ws.on("error", (error) => {
    console.error(`[TagWS] WebSocket error:`, error);
    tagService.removeWsClient(ws);
  });
}

// =============================================================================
// DEMO SETUP
// =============================================================================

/**
 * Initialize tag service with demo tank configuration
 * Connects to @oxscada/modbus-sim
 */
export async function initDemoTags(): Promise<void> {
  // Register tank tags matching modbus-sim register map
  tagService.registerTags([
    {
      name: "TK-101.Level",
      address: "IR:10", // Input Register 10
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
      deadband: 0.2,
    },
    {
      name: "TK-102.Level",
      address: "IR:20",
      unit: "%",
      scanRate: 500,
      deadband: 0.5,
      alarmConfig: { lowLow: 10, low: 25, high: 80, highHigh: 90 },
    },
    {
      name: "TK-102.Temperature",
      address: "IR:21",
      unit: "°C",
      scanRate: 1000,
      deadband: 0.2,
    },
    {
      name: "TK-103.Level",
      address: "IR:30",
      unit: "%",
      scanRate: 500,
      deadband: 0.5,
      alarmConfig: { lowLow: 10, low: 20, high: 85, highHigh: 95 },
    },
    {
      name: "TK-103.Temperature",
      address: "IR:31",
      unit: "°C",
      scanRate: 1000,
      deadband: 0.2,
    },
  ]);

  // Try to connect to local simulator
  try {
    await tagService.connect("localhost", 5020);
    console.log(`[TagService] Connected to demo simulator`);
  } catch {
    console.log(`[TagService] Demo simulator not running - start with: cd packages/modbus-sim && npm run dev`);
  }
}
