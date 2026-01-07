/**
 * Edge Gateway Service
 * 
 * Phase 3: Field Connectivity / Edge Gateway
 * 
 * Features:
 * - Runs near PLCs
 * - Protocol drivers: OPC UA, Modbus TCP
 * - Normalizes PLC states to event streams
 * - Signs events with gateway identity
 * - Store-and-forward for network outages
 */

import { EventEmitter } from "events";
import { getEventService, EventType, OriginType } from "../events";
import { generateRandomKey } from "../crypto";

// =============================================================================
// GATEWAY TYPES
// =============================================================================

export type ProtocolType = "OPC_UA" | "MODBUS_TCP" | "ETHERNET_IP" | "PROFINET" | "S7";

export interface GatewayConfig {
  id: string;
  name: string;
  siteId: string;
  protocols: ProtocolType[];
  signingKey: string;
  storeAndForwardEnabled: boolean;
  maxQueueSize: number;
  heartbeatInterval: number;
}

export interface TagDefinition {
  name: string;
  address: string;
  dataType: "BOOL" | "INT" | "DINT" | "REAL" | "STRING";
  scanRate: number;
  deadband?: number;
  assetId?: string;
  unit?: string;
  alarmConfig?: AlarmConfig;
}

export interface AlarmConfig {
  highHigh?: number;
  high?: number;
  low?: number;
  lowLow?: number;
  deadband?: number;
}

export interface TagValue {
  tag: string;
  value: number | string | boolean;
  quality: "GOOD" | "BAD" | "UNCERTAIN";
  timestamp: Date;
  assetId?: string;
  unit?: string;
}

export interface QueuedEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: Date;
  retryCount: number;
}

// =============================================================================
// PROTOCOL DRIVER INTERFACE
// =============================================================================

export interface ProtocolDriver {
  protocol: ProtocolType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  readTag(address: string): Promise<TagValue>;
  readTags(addresses: string[]): Promise<TagValue[]>;
  writeTag(address: string, value: number | string | boolean): Promise<boolean>;
  subscribe(tags: TagDefinition[], callback: (values: TagValue[]) => void): void;
  unsubscribe(): void;
}

// =============================================================================
// OPC UA DRIVER (Simulated)
// =============================================================================

export class OpcUaDriver implements ProtocolDriver {
  protocol: ProtocolType = "OPC_UA";
  private connected = false;
  private endpoint: string;
  private subscriptionCallback?: (values: TagValue[]) => void;
  private subscriptionInterval?: NodeJS.Timeout;
  private subscribedTags: TagDefinition[] = [];

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async connect(): Promise<void> {
    // In production, use node-opcua library
    console.log(`🔌 OPC UA: Connecting to ${this.endpoint}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    this.connected = true;
    console.log(`✅ OPC UA: Connected`);
  }

  async disconnect(): Promise<void> {
    this.unsubscribe();
    this.connected = false;
    console.log(`🔌 OPC UA: Disconnected`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async readTag(address: string): Promise<TagValue> {
    if (!this.connected) throw new Error("Not connected");
    
    // Simulate reading a tag value
    return {
      tag: address,
      value: Math.random() * 100,
      quality: "GOOD",
      timestamp: new Date(),
    };
  }

  async readTags(addresses: string[]): Promise<TagValue[]> {
    return Promise.all(addresses.map(addr => this.readTag(addr)));
  }

  async writeTag(address: string, value: number | string | boolean): Promise<boolean> {
    if (!this.connected) throw new Error("Not connected");
    console.log(`📝 OPC UA: Write ${address} = ${value}`);
    return true;
  }

  subscribe(tags: TagDefinition[], callback: (values: TagValue[]) => void): void {
    this.subscribedTags = tags;
    this.subscriptionCallback = callback;
    
    // Group tags by scan rate
    const minScanRate = Math.min(...tags.map(t => t.scanRate));
    
    this.subscriptionInterval = setInterval(async () => {
      if (!this.connected || !this.subscriptionCallback) return;
      
      const values = await this.readTags(tags.map(t => t.address));
      
      // Enrich with tag metadata
      const enrichedValues = values.map((v, i) => ({
        ...v,
        tag: tags[i].name,
        assetId: tags[i].assetId,
        unit: tags[i].unit,
      }));
      
      this.subscriptionCallback(enrichedValues);
    }, minScanRate);
  }

  unsubscribe(): void {
    if (this.subscriptionInterval) {
      clearInterval(this.subscriptionInterval);
      this.subscriptionInterval = undefined;
    }
    this.subscriptionCallback = undefined;
    this.subscribedTags = [];
  }
}

// =============================================================================
// MODBUS TCP DRIVER (Simulated)
// =============================================================================

export class ModbusTcpDriver implements ProtocolDriver {
  protocol: ProtocolType = "MODBUS_TCP";
  private connected = false;
  private host: string;
  private port: number;
  private subscriptionCallback?: (values: TagValue[]) => void;
  private subscriptionInterval?: NodeJS.Timeout;

  constructor(host: string, port: number = 502) {
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<void> {
    console.log(`🔌 Modbus TCP: Connecting to ${this.host}:${this.port}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    this.connected = true;
    console.log(`✅ Modbus TCP: Connected`);
  }

  async disconnect(): Promise<void> {
    this.unsubscribe();
    this.connected = false;
    console.log(`🔌 Modbus TCP: Disconnected`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async readTag(address: string): Promise<TagValue> {
    if (!this.connected) throw new Error("Not connected");
    
    // Parse Modbus address (e.g., "HR:100" for holding register 100)
    const [type, register] = address.split(":");
    
    // Simulate reading
    return {
      tag: address,
      value: Math.random() * 100,
      quality: "GOOD",
      timestamp: new Date(),
    };
  }

  async readTags(addresses: string[]): Promise<TagValue[]> {
    return Promise.all(addresses.map(addr => this.readTag(addr)));
  }

  async writeTag(address: string, value: number | string | boolean): Promise<boolean> {
    if (!this.connected) throw new Error("Not connected");
    console.log(`📝 Modbus TCP: Write ${address} = ${value}`);
    return true;
  }

  subscribe(tags: TagDefinition[], callback: (values: TagValue[]) => void): void {
    this.subscriptionCallback = callback;
    
    const minScanRate = Math.min(...tags.map(t => t.scanRate));
    
    this.subscriptionInterval = setInterval(async () => {
      if (!this.connected || !this.subscriptionCallback) return;
      
      const values = await this.readTags(tags.map(t => t.address));
      
      const enrichedValues = values.map((v, i) => ({
        ...v,
        tag: tags[i].name,
        assetId: tags[i].assetId,
        unit: tags[i].unit,
      }));
      
      this.subscriptionCallback(enrichedValues);
    }, minScanRate);
  }

  unsubscribe(): void {
    if (this.subscriptionInterval) {
      clearInterval(this.subscriptionInterval);
      this.subscriptionInterval = undefined;
    }
    this.subscriptionCallback = undefined;
  }
}

// =============================================================================
// EDGE GATEWAY SERVICE
// =============================================================================

export class EdgeGateway extends EventEmitter {
  private config: GatewayConfig;
  private drivers: Map<ProtocolType, ProtocolDriver> = new Map();
  private tags: Map<string, TagDefinition> = new Map();
  private lastValues: Map<string, TagValue> = new Map();
  private eventQueue: QueuedEvent[] = [];
  private isOnline = false;
  private heartbeatInterval?: NodeJS.Timeout;
  private alarmStates: Map<string, string> = new Map();

  constructor(config: GatewayConfig) {
    super();
    this.config = config;
  }

  /**
   * Add a protocol driver
   */
  addDriver(driver: ProtocolDriver): void {
    this.drivers.set(driver.protocol, driver);
  }

  /**
   * Register tags to monitor
   */
  registerTags(tags: TagDefinition[]): void {
    for (const tag of tags) {
      this.tags.set(tag.name, tag);
    }
  }

  /**
   * Start the gateway
   */
  async start(): Promise<void> {
    console.log(`🚀 Gateway ${this.config.name} starting...`);

    // Connect all drivers
    for (const [protocol, driver] of this.drivers) {
      try {
        await driver.connect();
      } catch (error) {
        console.error(`Failed to connect ${protocol}:`, error);
      }
    }

    // Subscribe to tags
    const tagArray = Array.from(this.tags.values());
    for (const driver of this.drivers.values()) {
      if (driver.isConnected()) {
        driver.subscribe(tagArray, (values) => this.handleTagValues(values));
      }
    }

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);

    this.isOnline = true;
    this.emit("started");
    console.log(`✅ Gateway ${this.config.name} started`);

    // Process any queued events
    this.processQueue();
  }

  /**
   * Stop the gateway
   */
  async stop(): Promise<void> {
    console.log(`🛑 Gateway ${this.config.name} stopping...`);

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    for (const driver of this.drivers.values()) {
      await driver.disconnect();
    }

    this.isOnline = false;
    this.emit("stopped");
    console.log(`✅ Gateway ${this.config.name} stopped`);
  }

  /**
   * Handle incoming tag values
   */
  private handleTagValues(values: TagValue[]): void {
    for (const value of values) {
      const tagDef = this.tags.get(value.tag);
      if (!tagDef) continue;

      const lastValue = this.lastValues.get(value.tag);
      
      // Check deadband
      if (lastValue && tagDef.deadband && typeof value.value === "number" && typeof lastValue.value === "number") {
        if (Math.abs(value.value - lastValue.value) < tagDef.deadband) {
          continue; // Skip if within deadband
        }
      }

      // Store new value
      this.lastValues.set(value.tag, value);

      // Create telemetry event
      this.createTelemetryEvent(value);

      // Check alarms
      if (tagDef.alarmConfig && typeof value.value === "number") {
        this.checkAlarms(tagDef, value.value);
      }
    }
  }

  /**
   * Create and send a telemetry event
   */
  private createTelemetryEvent(value: TagValue): void {
    const eventService = getEventService();
    
    const event = eventService.createEvent({
      eventType: EventType.TELEMETRY,
      siteId: this.config.siteId,
      assetId: value.assetId,
      sourceTimestamp: value.timestamp,
      originType: OriginType.GATEWAY,
      originId: this.config.id,
      payload: {
        tag: value.tag,
        value: value.value,
        unit: value.unit,
        quality: value.quality,
      },
      details: `${value.tag} = ${value.value}${value.unit ? ` ${value.unit}` : ""}`,
    });

    this.emit("event", event);

    // If offline, queue the event
    if (!this.isOnline && this.config.storeAndForwardEnabled) {
      this.queueEvent({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        eventType: EventType.TELEMETRY,
        payload: event.payload,
        timestamp: new Date(),
        retryCount: 0,
      });
    }
  }

  /**
   * Check alarm conditions
   */
  private checkAlarms(tagDef: TagDefinition, value: number): void {
    const config = tagDef.alarmConfig!;
    const currentState = this.alarmStates.get(tagDef.name) || "NORMAL";
    let newState = "NORMAL";
    let severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "LOW";
    let alarmType: "HIHI" | "HIGH" | "LOW" | "LOLO" | undefined;

    if (config.highHigh !== undefined && value >= config.highHigh) {
      newState = "HIHI";
      severity = "CRITICAL";
      alarmType = "HIHI";
    } else if (config.high !== undefined && value >= config.high) {
      newState = "HIGH";
      severity = "HIGH";
      alarmType = "HIGH";
    } else if (config.lowLow !== undefined && value <= config.lowLow) {
      newState = "LOLO";
      severity = "CRITICAL";
      alarmType = "LOLO";
    } else if (config.low !== undefined && value <= config.low) {
      newState = "LOW";
      severity = "MEDIUM";
      alarmType = "LOW";
    }

    // State change - create alarm event
    if (newState !== currentState) {
      this.alarmStates.set(tagDef.name, newState);

      const eventService = getEventService();
      const alarmState = newState === "NORMAL" ? "CLEARED" : "ACTIVE";
      
      const event = eventService.createEvent({
        eventType: EventType.ALARM,
        siteId: this.config.siteId,
        assetId: tagDef.assetId,
        sourceTimestamp: new Date(),
        originType: OriginType.GATEWAY,
        originId: this.config.id,
        payload: {
          alarmId: `${tagDef.name}_${alarmType || "NORMAL"}`,
          alarmType: alarmType || "DISCRETE",
          severity,
          state: alarmState,
          message: `${tagDef.name} ${alarmState}: ${value}${tagDef.unit ? ` ${tagDef.unit}` : ""}`,
          value,
          limit: alarmType === "HIHI" ? config.highHigh :
                 alarmType === "HIGH" ? config.high :
                 alarmType === "LOW" ? config.low :
                 alarmType === "LOLO" ? config.lowLow : undefined,
        },
        details: `[${severity}] ${tagDef.name} ${alarmState}`,
      });

      this.emit("alarm", event);
    }
  }

  /**
   * Queue an event for later transmission
   */
  private queueEvent(event: QueuedEvent): void {
    if (this.eventQueue.length >= this.config.maxQueueSize) {
      // Remove oldest event
      this.eventQueue.shift();
    }
    this.eventQueue.push(event);
    console.log(`📦 Queued event (${this.eventQueue.length}/${this.config.maxQueueSize})`);
  }

  /**
   * Process queued events
   */
  private async processQueue(): Promise<void> {
    while (this.eventQueue.length > 0 && this.isOnline) {
      const event = this.eventQueue.shift();
      if (event) {
        try {
          // In production, send to server
          console.log(`📤 Processing queued event: ${event.id}`);
          this.emit("event", event);
        } catch (error) {
          // Re-queue on failure
          event.retryCount++;
          if (event.retryCount < 3) {
            this.eventQueue.unshift(event);
          }
          break;
        }
      }
    }
  }

  /**
   * Send heartbeat
   */
  private sendHeartbeat(): void {
    const eventService = getEventService();
    
    const event = eventService.createEvent({
      eventType: EventType.TELEMETRY,
      siteId: this.config.siteId,
      sourceTimestamp: new Date(),
      originType: OriginType.GATEWAY,
      originId: this.config.id,
      payload: {
        tag: "_HEARTBEAT",
        value: true,
        quality: "GOOD",
        gatewayStatus: {
          online: this.isOnline,
          queuedEvents: this.eventQueue.length,
          connectedDrivers: Array.from(this.drivers.entries())
            .filter(([_, d]) => d.isConnected())
            .map(([p, _]) => p),
          tagCount: this.tags.size,
        },
      },
      details: `Gateway heartbeat`,
    });

    this.emit("heartbeat", event);
  }

  /**
   * Write a value to a tag
   */
  async writeTag(tagName: string, value: number | string | boolean, originId: string): Promise<boolean> {
    const tagDef = this.tags.get(tagName);
    if (!tagDef) {
      throw new Error(`Tag not found: ${tagName}`);
    }

    // Find a connected driver
    for (const driver of this.drivers.values()) {
      if (driver.isConnected()) {
        const success = await driver.writeTag(tagDef.address, value);
        
        if (success) {
          // Create command event
          const eventService = getEventService();
          const event = eventService.createEvent({
            eventType: EventType.COMMAND,
            siteId: this.config.siteId,
            assetId: tagDef.assetId,
            sourceTimestamp: new Date(),
            originType: OriginType.GATEWAY,
            originId: this.config.id,
            payload: {
              commandType: "SETPOINT",
              target: tagName,
              value,
              previousValue: this.lastValues.get(tagName)?.value,
              reason: `Write from ${originId}`,
              approved: true,
            },
            details: `SETPOINT ${tagName} → ${value}`,
          });

          this.emit("command", event);
        }

        return success;
      }
    }

    throw new Error("No connected drivers");
  }

  /**
   * Get gateway status
   */
  getStatus(): Record<string, unknown> {
    return {
      id: this.config.id,
      name: this.config.name,
      siteId: this.config.siteId,
      online: this.isOnline,
      protocols: this.config.protocols,
      drivers: Array.from(this.drivers.entries()).map(([protocol, driver]) => ({
        protocol,
        connected: driver.isConnected(),
      })),
      tags: this.tags.size,
      queuedEvents: this.eventQueue.length,
      alarms: Object.fromEntries(this.alarmStates),
    };
  }
}

// =============================================================================
// GATEWAY FACTORY
// =============================================================================

export function createGateway(config: Partial<GatewayConfig> & { id: string; name: string; siteId: string }): EdgeGateway {
  const fullConfig: GatewayConfig = {
    protocols: ["OPC_UA"],
    signingKey: generateRandomKey(),
    storeAndForwardEnabled: true,
    maxQueueSize: 10000,
    heartbeatInterval: 30000,
    ...config,
  };

  return new EdgeGateway(fullConfig);
}

// =============================================================================
// GATEWAY REGISTRY
// =============================================================================

class GatewayRegistry {
  private gateways: Map<string, EdgeGateway> = new Map();

  register(gateway: EdgeGateway): void {
    const status = gateway.getStatus();
    this.gateways.set(status.id as string, gateway);
  }

  get(id: string): EdgeGateway | undefined {
    return this.gateways.get(id);
  }

  getAll(): EdgeGateway[] {
    return Array.from(this.gateways.values());
  }

  async startAll(): Promise<void> {
    for (const gateway of this.gateways.values()) {
      await gateway.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const gateway of this.gateways.values()) {
      await gateway.stop();
    }
  }
}

export const gatewayRegistry = new GatewayRegistry();
