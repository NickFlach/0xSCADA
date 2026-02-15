/**
 * Azure IoT Hub Integration
 *
 * Issue #20 — [Optix/IoT] Integrate Azure IoT Operations for cloud telemetry
 *
 * Features:
 * - Device-to-cloud (D2C) telemetry messages
 * - Cloud-to-device (C2D) command handling
 * - Device twin read/update (reported & desired properties)
 * - Connection lifecycle management with auto-reconnect
 * - Batch telemetry with configurable flush interval
 *
 * Requires: azure-iot-device, azure-iot-device-mqtt (npm packages)
 */

import { EventEmitter } from "events";

// =============================================================================
// TYPES
// =============================================================================

export interface AzureIoTConfig {
  /** IoT Hub device connection string */
  connectionString: string;
  /** Transport protocol — default MQTT */
  protocol?: "mqtt" | "amqp" | "http";
  /** Auto-reconnect on disconnect — default true */
  autoReconnect?: boolean;
  /** Batch telemetry flush interval in ms — default 5000 */
  batchFlushIntervalMs?: number;
  /** Max batch size before forced flush — default 50 */
  maxBatchSize?: number;
  /** Model ID for IoT Plug and Play — optional */
  modelId?: string;
}

export interface TelemetryMessage {
  /** Unique message ID (auto-generated if omitted) */
  messageId?: string;
  /** Telemetry payload — will be JSON-serialized */
  body: Record<string, unknown>;
  /** Custom properties attached to the message */
  properties?: Record<string, string>;
  /** Content type — default application/json */
  contentType?: string;
  /** Content encoding — default utf-8 */
  contentEncoding?: string;
}

export interface DeviceTwinPatch {
  /** Reported properties to update */
  [key: string]: unknown;
}

export interface CloudToDeviceCommand {
  /** Method name invoked from IoT Hub */
  methodName: string;
  /** Payload sent with the command */
  payload: unknown;
  /** Respond to the command */
  respond: (status: number, payload?: unknown) => Promise<void>;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// =============================================================================
// AZURE IOT CLIENT
// =============================================================================

export class AzureIoTClient extends EventEmitter {
  private config: Required<AzureIoTConfig>;
  private client: any = null;
  private twin: any = null;
  private state: ConnectionState = "disconnected";
  private telemetryBatch: TelemetryMessage[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AzureIoTConfig) {
    super();
    this.config = {
      connectionString: config.connectionString,
      protocol: config.protocol ?? "mqtt",
      autoReconnect: config.autoReconnect ?? true,
      batchFlushIntervalMs: config.batchFlushIntervalMs ?? 5000,
      maxBatchSize: config.maxBatchSize ?? 50,
      modelId: config.modelId ?? "",
    };
  }

  // ===========================================================================
  // Connection Lifecycle
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.state === "connected") return;

    this.setState("connecting");

    try {
      // Dynamic import — these are optional peer dependencies
      const { clientFromConnectionString } = await import("azure-iot-device-mqtt");
      const { Client } = await import("azure-iot-device");

      const transport = clientFromConnectionString(this.config.connectionString);
      this.client = Client.fromConnectionString(this.config.connectionString, transport);

      if (this.config.modelId) {
        this.client.setOptions({ modelId: this.config.modelId });
      }

      await this.client.open();
      this.setState("connected");

      // Wire up event handlers
      this.client.on("disconnect", () => this.handleDisconnect());
      this.client.on("error", (err: Error) => this.handleError(err));

      // Set up C2D method handler
      this.client.onDeviceMethod("*", (request: any, response: any) => {
        const cmd: CloudToDeviceCommand = {
          methodName: request.methodName,
          payload: request.payload,
          respond: async (status: number, payload?: unknown) => {
            response.send(status, payload);
          },
        };
        this.emit("command", cmd);
      });

      // Set up C2D message handler
      this.client.on("message", (msg: any) => {
        this.emit("c2dMessage", {
          messageId: msg.messageId,
          body: msg.getData().toString("utf-8"),
          properties: msg.properties?.propertyList ?? [],
        });
        this.client.complete(msg);
      });

      // Get device twin
      this.twin = await this.client.getTwin();
      this.twin.on("properties.desired", (delta: any) => {
        this.emit("desiredProperties", delta);
      });

      // Start batch flush timer
      this.startBatchFlush();

      this.emit("connected");
    } catch (err) {
      this.setState("error");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopBatchFlush();
    await this.flushTelemetry();

    if (this.client) {
      await this.client.close();
      this.client = null;
      this.twin = null;
    }

    this.setState("disconnected");
  }

  getState(): ConnectionState {
    return this.state;
  }

  // ===========================================================================
  // Device-to-Cloud Telemetry
  // ===========================================================================

  /**
   * Queue a telemetry message for batched sending.
   * Messages are flushed every `batchFlushIntervalMs` or when batch is full.
   */
  enqueueTelemetry(message: TelemetryMessage): void {
    this.telemetryBatch.push(message);
    if (this.telemetryBatch.length >= this.config.maxBatchSize) {
      this.flushTelemetry().catch((err) => this.emit("error", err));
    }
  }

  /**
   * Send a single telemetry message immediately.
   */
  async sendTelemetry(message: TelemetryMessage): Promise<void> {
    this.ensureConnected();

    const { Message } = await import("azure-iot-device");
    const msg = new Message(JSON.stringify(message.body));

    msg.contentType = message.contentType ?? "application/json";
    msg.contentEncoding = message.contentEncoding ?? "utf-8";

    if (message.messageId) msg.messageId = message.messageId;
    if (message.properties) {
      for (const [key, value] of Object.entries(message.properties)) {
        msg.properties.add(key, value);
      }
    }

    await this.client.sendEvent(msg);
    this.emit("telemetrySent", message);
  }

  /**
   * Flush all queued telemetry messages.
   */
  async flushTelemetry(): Promise<number> {
    if (this.telemetryBatch.length === 0) return 0;

    const batch = this.telemetryBatch.splice(0);
    let sent = 0;
    for (const msg of batch) {
      try {
        await this.sendTelemetry(msg);
        sent++;
      } catch (err) {
        this.emit("error", err);
        // Re-queue failed messages
        this.telemetryBatch.unshift(msg);
      }
    }
    return sent;
  }

  // ===========================================================================
  // Device Twin
  // ===========================================================================

  /**
   * Read the full device twin (reported + desired properties).
   */
  async getTwinProperties(): Promise<{ reported: any; desired: any }> {
    this.ensureConnected();
    if (!this.twin) throw new Error("Twin not initialized");

    return {
      reported: this.twin.properties.reported,
      desired: this.twin.properties.desired,
    };
  }

  /**
   * Update reported properties on the device twin.
   */
  async updateReportedProperties(patch: DeviceTwinPatch): Promise<void> {
    this.ensureConnected();
    if (!this.twin) throw new Error("Twin not initialized");

    return new Promise((resolve, reject) => {
      this.twin.properties.reported.update(patch, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ===========================================================================
  // Cloud-to-Device Commands
  // ===========================================================================

  /**
   * Register a handler for a specific direct method.
   */
  onMethod(methodName: string, handler: (payload: unknown) => Promise<{ status: number; payload?: unknown }>): void {
    this.ensureConnected();
    this.client.onDeviceMethod(methodName, async (request: any, response: any) => {
      try {
        const result = await handler(request.payload);
        response.send(result.status, result.payload);
      } catch (err) {
        response.send(500, { error: String(err) });
      }
    });
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit("stateChange", state);
  }

  private ensureConnected(): void {
    if (this.state !== "connected" || !this.client) {
      throw new Error("Azure IoT client not connected");
    }
  }

  private async handleDisconnect(): Promise<void> {
    this.setState("disconnected");
    this.emit("disconnected");

    if (this.config.autoReconnect) {
      setTimeout(() => {
        this.connect().catch((err) => this.emit("error", err));
      }, 5000);
    }
  }

  private handleError(err: Error): void {
    this.setState("error");
    this.emit("error", err);
  }

  private startBatchFlush(): void {
    this.stopBatchFlush();
    this.flushTimer = setInterval(() => {
      this.flushTelemetry().catch((err) => this.emit("error", err));
    }, this.config.batchFlushIntervalMs);
  }

  private stopBatchFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create and connect an Azure IoT client.
 */
export async function createAzureIoTClient(config: AzureIoTConfig): Promise<AzureIoTClient> {
  const client = new AzureIoTClient(config);
  await client.connect();
  return client;
}
